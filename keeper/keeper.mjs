#!/usr/bin/env node
/**
 * Kairos Layer — settlement keeper.
 *
 * Drives epochs to settlement without supervision. Every action it takes is
 * permissionless: the keeper is a convenience, never a trust assumption, and
 * anyone may run one. If every keeper stops, users are still protected by the
 * contract's timeouts and can recover their funds themselves.
 *
 * Loop per tick:
 *   1. seal any epoch whose window has closed
 *   2. reveal sealed epochs (fetch enclave proofs for both side totals)
 *   3. net revealed epochs
 *   4. finalize pending unwraps (release residual → swap on Uniswap)
 *   5. rescue anything stuck past its timeout, so funds are never stranded
 *
 * Usage:
 *   node keeper.mjs               # run forever
 *   node keeper.mjs --once        # single pass, useful for cron
 *   node keeper.mjs --dry-run     # report what it would do, send nothing
 *
 * Reads KEEPER_PRIVATE_KEY (falls back to SEPOLIA_PRIVATE_KEY) from ../contracts/.env
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";

const ONCE = process.argv.includes("--once");
const DRY = process.argv.includes("--dry-run");
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 20_000);

/**
 * An epoch that expires with orders in it MUST be sealed — users are waiting.
 * An epoch that expires EMPTY only needs sealing so the next one can open, and
 * sealing costs ~120k gas every time. Rolling an idle pool every few minutes
 * burns real money for nobody's benefit, so empty epochs are left to age and
 * rolled on a slower cadence. A trader who arrives meanwhile can open the next
 * epoch themselves from the UI for the same trivial gas.
 *
 * Net effect: keeper cost scales with usage, not with the clock.
 */
const SEAL_EMPTY_AFTER_S = Number(process.env.KEEPER_SEAL_EMPTY_AFTER_S ?? 1800);

// ---------- config ----------

const root = new URL("../contracts/", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL(".env", root), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const D = JSON.parse(readFileSync(new URL("deployments.json", root), "utf8"));
const POOL_ABI = JSON.parse(
  readFileSync(new URL("artifacts/contracts/KairosPool.sol/KairosPool.json", root), "utf8"),
).abi;

const RPCS = [
  env.SEPOLIA_RPC_URL,
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
].filter(Boolean);

const rawKey = env.KEEPER_PRIVATE_KEY || env.SEPOLIA_PRIVATE_KEY;
if (!rawKey) {
  console.error("No KEEPER_PRIVATE_KEY or SEPOLIA_PRIVATE_KEY in contracts/.env");
  process.exit(1);
}
const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`);

const pub = createPublicClient({
  chain: sepolia,
  transport: fallback(RPCS.map((u) => http(u, { timeout: 20_000 }))),
  batch: { multicall: true },
});
const wallet = createWalletClient({ account, chain: sepolia, transport: fallback(RPCS.map((u) => http(u))) });

let handleClient;
const nox = async () => (handleClient ??= await createViemHandleClient(wallet));

// ---------- helpers ----------

const STATE = ["None", "Open", "Sealed", "Revealed", "UnwrapPending", "Distributable", "Cancelled"];
const ZERO32 = `0x${"0".repeat(64)}`;

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`${ts()}  ${msg}`);
const warn = (msg) => console.warn(`${ts()}  ! ${msg}`);

const read = (fn, args = []) =>
  pub.readContract({ address: D.KairosPool, abi: POOL_ABI, functionName: fn, args });

async function send(fn, args, label) {
  if (DRY) {
    log(`[dry-run] would call ${fn}(${args.map(String).join(", ")})`);
    return null;
  }
  const hash = await wallet.writeContract({
    address: D.KairosPool,
    abi: POOL_ABI,
    functionName: fn,
    args,
    account,
    chain: sepolia,
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${label} reverted`);
  log(`   ${label} ok  ${hash.slice(0, 18)}…`);
  return hash;
}

/** publicDecrypt with patience — live enclave round trips take tens of seconds. */
async function proofFor(handle, attempts = 40, delayMs = 5000) {
  const client = await nox();
  for (let i = 0; i < attempts; i++) {
    try {
      return (await client.publicDecrypt(handle)).decryptionProof;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("enclave did not release the value in time");
}

// ---------- the crank ----------

async function tick() {
  const now = Math.floor(Date.now() / 1000);
  const current = await read("currentEpochId");

  // Look back a few epochs: older ones may still need finishing.
  const ids = [];
  for (let i = 0n; i < 6n && current - i >= 1n; i++) ids.push(current - i);
  const epochs = await Promise.all(ids.map((id) => read("getEpoch", [id])));

  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    const e = epochs[i];

    try {
      // 1. seal a closed window
      if (e.state === 1 && now >= Number(e.endTime)) {
        const hasOrders = e.buyCount > 0 || e.sellCount > 0;
        const idleFor = now - Number(e.endTime);
        if (hasOrders) {
          log(`epoch ${id}: window closed with ${e.buyCount}B/${e.sellCount}S → seal`);
          await send("seal", [], "seal");
        } else if (idleFor >= SEAL_EMPTY_AFTER_S) {
          log(`epoch ${id}: empty and idle ${Math.round(idleFor / 60)}min → rolling forward`);
          await send("seal", [], "seal");
        } else {
          log(
            `epoch ${id}: empty, expired ${idleFor}s ago — holding (rolls at ${SEAL_EMPTY_AFTER_S}s, or when a trader opens it)`,
          );
        }
        continue;
      }

      // 2. reveal
      if (e.state === 2) {
        log(`epoch ${id}: sealed → fetching enclave proofs`);
        const buyProof = e.buyCount > 0 ? await proofFor(e.buyTotalEnc) : "0x";
        const sellProof = e.sellCount > 0 ? await proofFor(e.sellTotalEnc) : "0x";
        await send("reveal", [id, buyProof, sellProof], "reveal");
        continue;
      }

      // 3. net
      if (e.state === 3) {
        log(`epoch ${id}: revealed → netting`);
        await send("initiateSettlement", [id], "initiateSettlement");
        continue;
      }

      // 4. finalize: release residual and swap it
      if (e.state === 4) {
        const age = now - Number(e.unwrapRequestedAt);
        log(`epoch ${id}: unwrap pending (${age}s) → finalize`);
        try {
          const proof = await proofFor(e.unwrapRequestId);
          await send("finalizeSettlement", [id, proof, 0n], "finalizeSettlement");
        } catch (err) {
          warn(`epoch ${id}: finalize failed — ${err.shortMessage || err.message}`);
          // 5a. residual released but unswappable → give it back
          if (age >= Number(e.unwrapTimeoutSnap)) {
            log(`epoch ${id}: past unwrap timeout → attempting recovery`);
            await send("recoverEpoch", [id], "recoverEpoch").catch((x) =>
              warn(`   recover not yet possible: ${x.shortMessage || x.message}`),
            );
          }
        }
        continue;
      }

      // 5b. stuck sealed/revealed past the reveal timeout → cancel for refunds
      if ((e.state === 2 || e.state === 3) && Number(e.sealedAt) > 0) {
        if (now >= Number(e.sealedAt) + Number(e.revealTimeoutSnap)) {
          warn(`epoch ${id}: reveal timeout exceeded → cancelling so users can refund`);
          await send("cancelEpoch", [id], "cancelEpoch");
        }
      }
    } catch (err) {
      warn(`epoch ${id}: ${err.shortMessage || err.message}`);
    }
  }

  // Health line so an operator can see it is alive and solvent.
  const bal = await pub.getBalance({ address: account.address });
  const head = await read("getEpoch", [current]);
  const left = Math.max(0, Number(head.endTime) - now);
  log(
    `idle · epoch ${current} ${STATE[head.state]} (${head.buyCount}B/${head.sellCount}S, ${left}s left) · gas ${(Number(bal) / 1e18).toFixed(4)} ETH`,
  );
  if (bal < 3n * 10n ** 15n) warn("keeper balance below 0.003 ETH — top up soon");
}

// ---------- main ----------

console.log("Kairos keeper");
console.log(`  pool     ${D.KairosPool}`);
console.log(`  keeper   ${account.address}`);
console.log(`  mode     ${DRY ? "dry-run" : "live"}${ONCE ? " (single pass)" : ""}\n`);

if (ONCE) {
  await tick();
} else {
  for (;;) {
    try {
      await tick();
    } catch (err) {
      warn(`tick failed: ${err.shortMessage || err.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}
