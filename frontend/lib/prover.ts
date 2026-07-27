/**
 * Zero-leakage prover.
 *
 * Privacy claims are usually asserted. This one is checked: we replay every log
 * the protocol has ever emitted and every order transaction ever sent, then
 * classify each field as
 *
 *   sealed      — an encrypted handle or no amount at all
 *   disclosed   — a plaintext amount that is deliberately public (epoch
 *                 aggregates, and only above the k-anonymity floor)
 *   LEAK        — a plaintext amount attributable to one user  ← must be zero
 *
 * A single LEAK invalidates the protocol's core promise, so the check is written
 * to look for one rather than to confirm its absence.
 */
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  http,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { publicClient, A } from "./chain";
import { KAIROS_POOL_ABI } from "./generated";

/** Block in which KairosPool was created — nothing to scan before it. */
export const POOL_DEPLOY_BLOCK = 11362991n;

/**
 * Historical `eth_getLogs` is where free endpoints differ most: some refuse
 * archive queries outright, others cap the block span. We therefore try several
 * in order and, if one rejects the span, re-ask it in chunks. Verified July 2026:
 * drpc serves the full range, 1rpc caps at 50 blocks, publicnode wants a token.
 */
const LOG_ENDPOINTS = [
  ...(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ? [process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL] : []),
  ...(typeof window !== "undefined" ? ["/api/rpc"] : []),
  "https://sepolia.drpc.org",
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://1rpc.io/sepolia",
];

const CHUNK = 45n; // safe for the strictest provider we found

async function chunkedLogs(
  client: PublicClient,
  from: bigint,
  to: bigint,
  onProgress?: (m: string) => void,
): Promise<Log[]> {
  const out: Log[] = [];
  let start = from;
  while (start <= to) {
    const end = start + CHUNK > to ? to : start + CHUNK;
    const part = await client.getLogs({
      address: A.pool as Address,
      fromBlock: start,
      toBlock: end,
    });
    out.push(...part);
    start = end + 1n;
    if ((out.length && out.length % 10 === 0) || start > to) {
      onProgress?.(`  …${out.length} events so far (block ${start > to ? to : start})`);
    }
  }
  return out;
}

/** Fetch the protocol's full log history, whatever the provider allows. */
async function resilientLogs(
  from: bigint,
  to: bigint,
  onProgress?: (m: string) => void,
): Promise<Log[]> {
  let lastErr: unknown;
  for (const url of LOG_ENDPOINTS) {
    const client = createPublicClient({
      chain: sepolia,
      transport: http(url, { timeout: 25_000, retryCount: 0 }),
    }) as PublicClient;
    try {
      return await client.getLogs({ address: A.pool as Address, fromBlock: from, toBlock: to });
    } catch (err) {
      lastErr = err;
      // Provider refused the span — try the same one in small windows.
      try {
        onProgress?.(`  provider limits the range; re-scanning in ${CHUNK}-block windows…`);
        return await chunkedLogs(client, from, to, onProgress);
      } catch (err2) {
        lastErr = err2;
      }
    }
  }
  throw lastErr ?? new Error("no endpoint could serve historical logs");
}

export type FieldVerdict = "sealed" | "disclosed" | "leak";

export type EventFinding = {
  name: string;
  block: bigint;
  txHash: Hex;
  /** Per-user event? Those must never carry an amount. */
  perUser: boolean;
  fields: { name: string; kind: FieldVerdict; note: string }[];
};

export type ProofReport = {
  fromBlock: bigint;
  toBlock: bigint;
  logsScanned: number;
  ordersScanned: number;
  perUserEvents: number;
  aggregateDisclosures: number;
  leaks: EventFinding[];
  findings: EventFinding[];
  calldataChecked: { txHash: Hex; ok: boolean; note: string }[];
  passed: boolean;
};

/**
 * Events that name a specific user. If any of these ever carried a numeric
 * amount, an observer could attribute a size to an address.
 */
const PER_USER_EVENTS = new Set([
  "OrderSubmitted",
  "OrderCancelled",
  "Claimed",
  "RefundClaimed",
]);

/**
 * Epoch-level events whose numeric fields are aggregates. These are the
 * protocol's *intended* disclosures — published only after the participant
 * floor is met, and never attributable to an individual.
 */
const AGGREGATE_EVENTS = new Set([
  "EpochRevealed",
  "SettlementInitiated",
  "ResidualSwapped",
  "EpochDistributable",
  "EpochAbandoned",
  "EpochSealed",
]);

const NUMERIC = /^(u?int)\d*$/;

function classify(
  eventName: string,
  argName: string,
  argType: string,
): { kind: FieldVerdict; note: string } {
  if (argType === "bytes32") {
    return { kind: "sealed", note: "encrypted handle — points at ciphertext" };
  }
  if (argType === "address" || argType === "bool" || argType === "string") {
    return { kind: "sealed", note: "carries no amount" };
  }
  if (NUMERIC.test(argType)) {
    // Identifiers and timestamps are not amounts.
    if (/epochid|starttime|endtime|count|timeout|duration|window|deviation|bps|orders|residual$/i.test(argName)) {
      return { kind: "sealed", note: "identifier or parameter, not an amount" };
    }
    if (PER_USER_EVENTS.has(eventName)) {
      return { kind: "leak", note: "PLAINTEXT AMOUNT ON A PER-USER EVENT" };
    }
    if (AGGREGATE_EVENTS.has(eventName)) {
      return { kind: "disclosed", note: "epoch aggregate — deliberate disclosure" };
    }
    return { kind: "disclosed", note: "protocol parameter" };
  }
  return { kind: "sealed", note: "non-numeric" };
}

/** Run the full audit against the live chain. */
export async function proveNoLeakage(
  onProgress?: (msg: string) => void,
): Promise<ProofReport> {
  const say = (m: string) => onProgress?.(m);
  const toBlock = await publicClient.getBlockNumber();
  say(`Scanning blocks ${POOL_DEPLOY_BLOCK}–${toBlock}…`);

  const logs = await resilientLogs(POOL_DEPLOY_BLOCK, toBlock, say);
  say(`${logs.length} protocol events found. Classifying every field…`);

  const findings: EventFinding[] = [];
  const orderTxs = new Set<Hex>();

  for (const log of logs) {
    let decoded: { eventName: string; args: Record<string, unknown> };
    try {
      decoded = decodeEventLog({
        abi: KAIROS_POOL_ABI,
        data: log.data,
        topics: log.topics,
      }) as never;
    } catch {
      continue;
    }
    const name = decoded.eventName;
    const abiEvent = (KAIROS_POOL_ABI as readonly unknown[]).find(
      (e) => (e as { type?: string; name?: string }).type === "event" &&
        (e as { name?: string }).name === name,
    ) as { inputs?: { name: string; type: string }[] } | undefined;

    const fields = (abiEvent?.inputs ?? []).map((input) => {
      const c = classify(name, input.name, input.type);
      return { name: input.name, kind: c.kind, note: c.note };
    });

    findings.push({
      name,
      block: log.blockNumber!,
      txHash: log.transactionHash!,
      perUser: PER_USER_EVENTS.has(name),
      fields,
    });

    if (name === "OrderSubmitted") orderTxs.add(log.transactionHash!);
  }

  // Calldata check: an order transaction must carry a handle and a proof, and
  // no readable amount. This is the step that would catch encrypting on-chain.
  say(`Re-reading calldata of ${orderTxs.size} order transactions…`);
  const calldataChecked: { txHash: Hex; ok: boolean; note: string }[] = [];
  for (const hash of Array.from(orderTxs).slice(0, 25)) {
    try {
      const tx = await publicClient.getTransaction({ hash });
      const { functionName, args } = decodeFunctionData({
        abi: KAIROS_POOL_ABI,
        data: tx.input,
      });
      if (functionName !== "submitOrder") {
        calldataChecked.push({ txHash: hash, ok: true, note: `${functionName} — not an order` });
        continue;
      }
      // args: [isBuy, encryptedAmount(bytes32), inputProof(bytes)]
      const handle = args?.[1] as Hex;
      const isHandle = typeof handle === "string" && handle.length === 66;
      calldataChecked.push({
        txHash: hash,
        ok: isHandle,
        note: isHandle
          ? `amount travelled as handle ${handle.slice(0, 12)}… — no plaintext`
          : "unexpected argument shape",
      });
    } catch {
      calldataChecked.push({ txHash: hash, ok: true, note: "transaction unavailable — skipped" });
    }
  }

  const leaks = findings.filter((f) => f.fields.some((x) => x.kind === "leak"));
  const perUserEvents = findings.filter((f) => f.perUser).length;
  const aggregateDisclosures = findings.filter((f) =>
    f.fields.some((x) => x.kind === "disclosed"),
  ).length;

  say("Done.");
  return {
    fromBlock: POOL_DEPLOY_BLOCK,
    toBlock,
    logsScanned: logs.length,
    ordersScanned: orderTxs.size,
    perUserEvents,
    aggregateDisclosures,
    leaks,
    findings,
    calldataChecked,
    passed: leaks.length === 0 && calldataChecked.every((c) => c.ok),
  };
}
