"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  NextUp,
  Panel,
  PanelHead,
  PageHeader,
  Section,
} from "@/components/ui";
import { StateMachine, Figure } from "@/components/diagrams";
import { useWallet, sendTx } from "@/lib/wallet";
import { useEpoch, useNow, usePoolConfig, useRecentEpochs } from "@/lib/hooks";
import { A, QUOTE, BASE, labelFor } from "@/lib/chain";
import { KAIROS_POOL_ABI } from "@/lib/generated";
import { countdown, fmtUnits, revertReason } from "@/lib/format";
import { getHandleClient, publicDecryptWithRetry, ZERO_HANDLE } from "@/lib/nox";

/** The crank: whichever action the current epoch state allows. */
export default function Settle() {
  const { address, walletClient, connect } = useWallet();
  const [cfg] = usePoolConfig();
  const [recent, , refetchList] = useRecentEpochs(8);
  const now = useNow();

  // Target the oldest epoch that still needs work, else the current one.
  const pending = recent?.filter((r) => r.epoch.state >= 1 && r.epoch.state <= 4) ?? [];
  const target = pending.length ? pending[pending.length - 1] : recent?.[0];
  const [e, , refetchEpoch] = useEpoch(target?.id);

  const [busy, setBusy] = useState<string>();
  const [log, setLog] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string }>();

  const say = (s: string) => setLog((l) => [...l, s]);

  const refresh = () => {
    refetchEpoch();
    refetchList();
  };

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg(undefined);
    try {
      await fn();
      setMsg({ kind: "ok", text: `${label} complete.` });
      refresh();
    } catch (err) {
      setMsg({ kind: "err", text: revertReason(err) });
    } finally {
      setBusy(undefined);
    }
  };

  const doSeal = () =>
    act("Seal", async () => {
      if (!walletClient) throw new Error("connect a wallet");
      say("Sealing epoch — only the two side totals become decryptable.");
      await sendTx(walletClient, {
        address: A.pool,
        abi: KAIROS_POOL_ABI,
        functionName: "seal",
        args: [],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
      say("Sealed. A fresh epoch is now open for orders.");
    });

  const doReveal = () =>
    act("Reveal", async () => {
      if (!walletClient || !e || !target) throw new Error("not ready");
      const client = await getHandleClient(walletClient);
      say("Asking the enclave to decrypt the buy-side total…");
      const buyProof =
        e.buyCount > 0
          ? (await publicDecryptWithRetry(client, e.buyTotalEnc)).decryptionProof
          : "0x";
      say("Asking the enclave to decrypt the sell-side total…");
      const sellProof =
        e.sellCount > 0
          ? (await publicDecryptWithRetry(client, e.sellTotalEnc)).decryptionProof
          : "0x";
      say("Submitting both proofs — the contract verifies them on-chain.");
      await sendTx(walletClient, {
        address: A.pool,
        abi: KAIROS_POOL_ABI,
        functionName: "reveal",
        args: [target.id, buyProof, sellProof],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
      say("Totals proved. Nobody could have forged them.");
    });

  const doInitiate = () =>
    act("Net", async () => {
      if (!walletClient || !target) throw new Error("not ready");
      say("Crossing the two sides at the pool price (checked against its TWAP)…");
      await sendTx(walletClient, {
        address: A.pool,
        abi: KAIROS_POOL_ABI,
        functionName: "initiateSettlement",
        args: [target.id],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
      say("Matched volume settled internally. Any residual is now being released.");
    });

  const doFinalize = () =>
    act("Swap", async () => {
      if (!walletClient || !e || !target) throw new Error("not ready");
      const client = await getHandleClient(walletClient);
      say("Waiting for the enclave to release the residual…");
      const { decryptionProof } = await publicDecryptWithRetry(client, e.unwrapRequestId);
      say("Swapping the residual on Uniswap and re-encrypting the output…");
      await sendTx(walletClient, {
        address: A.pool,
        abi: KAIROS_POOL_ABI,
        functionName: "finalizeSettlement",
        args: [target.id, decryptionProof, 0n],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
      say("Settled. Everyone can claim.");
    });

  const state = e?.state ?? 0;
  const canSeal = state === 1 && e && Number(e.endTime) <= now;
  const steps = [
    {
      n: 1,
      label: "Seal",
      desc: "Close the window and publish exactly two totals.",
      ready: canSeal,
      done: state > 1,
      run: doSeal,
    },
    {
      n: 2,
      label: "Reveal",
      desc: "Fetch enclave proofs for both totals; the contract verifies them.",
      ready: state === 2,
      done: state > 2,
      run: doReveal,
    },
    {
      n: 3,
      label: "Net",
      desc: "Cancel buy against sell; compute the leftover imbalance.",
      ready: state === 3,
      done: state > 3,
      run: doInitiate,
    },
    {
      n: 4,
      label: "Swap",
      desc: "Release the residual and trade it on Uniswap as one order.",
      ready: state === 4,
      done: state === 5,
      run: doFinalize,
    },
  ];

  return (
    <>
      <PageHeader
        index="09 — Settlement desk"
        title="Anyone can push a batch forward."
        lede="Settlement is not automatic and it is not privileged. It is a short queue of steps that any address may execute — which is what stops the operator from being able to censor or stall a batch."
      />

      <Section title="Target batch" hint={target ? `epoch #${target.id}` : ""}>
        <Panel>
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-rule">
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                Epoch
              </div>
              <div className="font-mono tnum text-[15px] mt-1">
                {target ? `#${target.id}` : "—"}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                State
              </div>
              <div className="mt-1.5">
                <Badge tone={state === 5 ? "sealed" : state === 6 ? "exposed" : "muted"}>
                  {labelFor(state)}
                </Badge>
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                Orders
              </div>
              <div className="font-mono tnum text-[15px] mt-1">
                {e ? `${e.buyCount}B / ${e.sellCount}S` : "—"}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                {state === 1 ? "Window" : "Residual"}
              </div>
              <div className="font-mono tnum text-[15px] mt-1">
                {state === 1 && e
                  ? countdown(Number(e.endTime) - now)
                  : e && e.residualIn > 0n
                    ? e.residual === 2
                      ? `${fmtUnits(e.residualIn, 18, 4)} ${BASE.symbol}`
                      : `${fmtUnits(e.residualIn, 6, 0)} ${QUOTE.symbol}`
                    : "—"}
              </div>
            </div>
          </div>
        </Panel>
      </Section>

      <Section title="Run the crank">
        <div className="space-y-3">
          {steps.map((s) => (
            <Panel key={s.n}>
              <div className="px-4 py-3.5 flex items-center gap-4 flex-wrap">
                <div
                  className={`font-mono text-[12px] tnum w-6 ${
                    s.done ? "text-sealed" : s.ready ? "text-ink" : "text-ink-3/50"
                  }`}
                >
                  {s.done ? "✓" : String(s.n).padStart(2, "0")}
                </div>
                <div className="flex-1 min-w-[220px]">
                  <div className="font-medium text-[14.5px]">{s.label}</div>
                  <div className="text-[13px] text-ink-2 leading-snug">{s.desc}</div>
                </div>
                {!address ? (
                  <Button onClick={connect} variant="ghost">
                    Connect
                  </Button>
                ) : (
                  <Button onClick={s.run} disabled={!s.ready} busy={busy === s.label}>
                    {s.done ? "done" : s.label}
                  </Button>
                )}
              </div>
            </Panel>
          ))}
        </div>

        {msg && (
          <div
            className={`mt-4 border-l-2 px-4 py-3 text-[13.5px] ${
              msg.kind === "ok"
                ? "border-sealed/40 bg-sealed-bg text-sealed"
                : "border-exposed/40 bg-exposed-bg text-exposed"
            }`}
          >
            {msg.text}
          </div>
        )}

        {log.length > 0 && (
          <Panel className="mt-4">
            <PanelHead>
              <span>Activity</span>
              <button
                onClick={() => setLog([])}
                className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3"
              >
                clear
              </button>
            </PanelHead>
            <div className="p-4 space-y-1.5">
              {log.map((l, i) => (
                <div key={i} className="font-mono text-[12px] text-ink-2">
                  <span className="text-ink-3 mr-2">{String(i + 1).padStart(2, "0")}</span>
                  {l}
                </div>
              ))}
            </div>
          </Panel>
        )}
      </Section>

      <Section title="Why steps 2 and 4 take a while">
        <Callout kind="note" title="Two enclave round trips">
          Revealing the totals and releasing the residual both require the trusted enclave to
          decrypt and sign. On a live network that takes tens of seconds — the app polls until the
          proof is ready. This is the honest cost of computing on encrypted state, and it is why
          settlement is a queue rather than a single transaction.
        </Callout>
      </Section>

      <Section title="If a step never happens">
        <Figure caption="Dashed paths are the escape hatches. Each is permissionless, time-locked, and returns every deposit in full.">
          <StateMachine />
        </Figure>
        <div className="grid sm:grid-cols-3 gap-px bg-rule border border-rule mt-4">
          {[
            ["Reveal never comes", `after ${cfg ? Number(cfg.revealTimeout) / 60 : 60} min`, "anyone cancels the epoch; everyone is refunded"],
            ["Swap keeps failing", `after ${cfg ? Number(cfg.unwrapTimeout) / 60 : 15} min`, "the residual is re-wrapped and refunded"],
            ["Enclave never answers", `after ${cfg ? (Number(cfg.unwrapTimeout) * 3) / 60 : 45} min`, "the matched portion still pays out"],
          ].map(([t, when, what]) => (
            <div key={t} className="bg-card px-4 py-3">
              <div className="font-medium text-[13.5px]">{t}</div>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3 mt-1">
                {when}
              </div>
              <p className="text-[12.5px] text-ink-2 mt-1 leading-snug">{what}</p>
            </div>
          ))}
        </div>
        <p className="text-[13px] text-ink-3 mt-3">
          No state in this protocol can strand user funds — see{" "}
          <Link href="/security" className="underline underline-offset-2">
            security
          </Link>{" "}
          for how that was tested.
        </p>
      </Section>

      <NextUp href="/security" label="Security" />
    </>
  );
}
