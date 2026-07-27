"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Callout,
  NextUp,
  Panel,
  PanelHead,
  PageHeader,
  Section,
  Ext,
  Stat,
} from "@/components/ui";
import { proveNoLeakage, type ProofReport } from "@/lib/prover";
import { A, scan } from "@/lib/chain";
import { revertReason } from "@/lib/format";

export default function Proof() {
  const [report, setReport] = useState<ProofReport>();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const run = async () => {
    setBusy(true);
    setErr(undefined);
    setReport(undefined);
    setLog([]);
    try {
      const r = await proveNoLeakage((m) => setLog((l) => [...l, m]));
      setReport(r);
    } catch (e) {
      setErr(revertReason(e));
    } finally {
      setBusy(false);
    }
  };

  const byName = report
    ? Object.entries(
        report.findings.reduce<Record<string, number>>((acc, f) => {
          acc[f.name] = (acc[f.name] ?? 0) + 1;
          return acc;
        }, {}),
      ).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <>
      <PageHeader
        index="10 — Proof of no leakage"
        title="Do not trust the privacy claim. Check it."
        lede="Most privacy projects ask you to believe them. This page replays every event the protocol has ever emitted and every order transaction ever sent, classifies each field, and looks for a plaintext amount attributable to a single user. Run it yourself — it reads the public chain, so you can reproduce it independently."
      />

      <Section title="What is being checked">
        <div className="grid sm:grid-cols-3 gap-px bg-rule border border-rule">
          {[
            {
              t: "Sealed",
              tone: "sealed" as const,
              d: "Encrypted handles, addresses, flags, identifiers, timestamps. Nothing an observer can turn into an amount.",
            },
            {
              t: "Disclosed",
              tone: "warn" as const,
              d: "Plaintext amounts that are deliberately public: epoch aggregates, published only once the participant floor is met.",
            },
            {
              t: "Leak",
              tone: "exposed" as const,
              d: "A plaintext amount on an event that names a user. Even one would break the protocol's core promise.",
            },
          ].map((c) => (
            <div key={c.t} className="bg-card p-4">
              <Badge tone={c.tone}>{c.t}</Badge>
              <p className="text-[13px] text-ink-2 leading-relaxed mt-2">{c.d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Run the audit" hint="reads Sepolia directly — nothing is cached">
        <Panel>
          <div className="p-4 flex items-center justify-between gap-4 flex-wrap">
            <p className="text-[13.5px] text-ink-2 max-w-[52ch]">
              Scans from the deployment block to the current head. Takes a few seconds.
            </p>
            <Button onClick={run} busy={busy}>
              {report ? "Run again" : "Run the audit"}
            </Button>
          </div>
          {log.length > 0 && (
            <div className="border-t border-rule px-4 py-3 space-y-1">
              {log.map((l, i) => (
                <div key={i} className="font-mono text-[12px] text-ink-3">
                  {l}
                </div>
              ))}
            </div>
          )}
        </Panel>
        {err && (
          <div className="mt-3 border-l-2 border-exposed/40 bg-exposed-bg px-4 py-3 text-[13.5px] text-exposed">
            {err}
          </div>
        )}
      </Section>

      {report && (
        <>
          <Section title="Verdict">
            <div
              className={`border-2 p-6 ${
                report.passed
                  ? "border-sealed/40 bg-sealed-bg"
                  : "border-exposed/50 bg-exposed-bg"
              }`}
            >
              <div
                className={`font-display text-[2rem] leading-tight ${
                  report.passed ? "text-sealed" : "text-exposed"
                }`}
              >
                {report.passed
                  ? "No per-user amount was ever published."
                  : `${report.leaks.length} leak(s) detected.`}
              </div>
              <p className="text-[13.5px] text-ink-2 mt-2 max-w-[70ch]">
                {report.passed ? (
                  <>
                    Every one of the {report.logsScanned} events emitted between blocks{" "}
                    {report.fromBlock.toString()} and {report.toBlock.toString()} was checked field
                    by field. {report.perUserEvents} of them name a specific address, and not one
                    carries a numeric amount. All {report.ordersScanned} order transactions passed
                    their amounts as encrypted handles.
                  </>
                ) : (
                  <>A field that should have been sealed was found in plaintext. Details below.</>
                )}
              </p>
            </div>
          </Section>

          <Section title="Scan summary">
            <Panel>
              <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-rule">
                <Stat label="Events scanned" value={report.logsScanned} />
                <Stat
                  label="Per-user events"
                  value={report.perUserEvents}
                  tone="sealed"
                  sub="all amount-free"
                />
                <Stat
                  label="Aggregate disclosures"
                  value={report.aggregateDisclosures}
                  sub="intentional, epoch-level"
                />
                <Stat
                  label="Leaks"
                  value={report.leaks.length}
                  tone={report.leaks.length ? "exposed" : "sealed"}
                />
              </div>
            </Panel>
          </Section>

          <Section title="Order calldata" hint="what the transaction actually carried">
            <Panel>
              <PanelHead>
                <span>submitOrder transactions</span>
                <Badge tone={report.calldataChecked.every((c) => c.ok) ? "sealed" : "exposed"}>
                  {report.calldataChecked.filter((c) => c.ok).length}/
                  {report.calldataChecked.length} clean
                </Badge>
              </PanelHead>
              {report.calldataChecked.length === 0 && (
                <div className="px-4 py-4 text-[13.5px] text-ink-3">
                  No orders submitted yet — place one and re-run.
                </div>
              )}
              {report.calldataChecked.map((c) => (
                <div
                  key={c.txHash}
                  className="px-4 py-2.5 border-b border-rule last:border-0 flex items-center justify-between gap-4 flex-wrap"
                >
                  <Ext href={scan(c.txHash, "tx")}>
                    <span className="font-mono text-[12px]">{c.txHash.slice(0, 22)}…</span>
                  </Ext>
                  <span
                    className={`font-mono text-[11.5px] ${c.ok ? "text-sealed" : "text-exposed"}`}
                  >
                    {c.note}
                  </span>
                </div>
              ))}
            </Panel>
          </Section>

          <Section title="Every event type, classified">
            <Panel>
              {byName.map(([name, count]) => {
                const sample = report.findings.find((f) => f.name === name)!;
                const hasLeak = sample.fields.some((f) => f.kind === "leak");
                return (
                  <div key={name} className="border-b border-rule last:border-0">
                    <div className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
                      <span className="font-mono text-[13px]">{name}</span>
                      <span className="font-mono text-[11px] text-ink-3">×{count}</span>
                      {sample.perUser && <Badge tone="muted">names a user</Badge>}
                      {hasLeak && <Badge tone="exposed">leak</Badge>}
                    </div>
                    <div className="px-4 pb-3 flex flex-wrap gap-1.5">
                      {sample.fields.map((f) => (
                        <span
                          key={f.name}
                          title={f.note}
                          className={`font-mono text-[10.5px] px-1.5 py-[2px] border ${
                            f.kind === "sealed"
                              ? "border-sealed/25 bg-sealed-bg text-sealed"
                              : f.kind === "disclosed"
                                ? "border-warn/30 bg-warn-bg text-warn"
                                : "border-exposed/40 bg-exposed-bg text-exposed"
                          }`}
                        >
                          {f.name}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </Panel>
            <p className="text-[13px] text-ink-3 mt-3 leading-snug">
              Hover any field for why it was classified that way. Note that{" "}
              <span className="font-mono text-[12px]">OrderSubmitted</span> carries only an epoch
              id, an address and a direction — the contract has no plaintext amount to emit even if
              it wanted to.
            </p>
          </Section>
        </>
      )}

      <Section title="Why this is stronger than an assertion">
        <Callout kind="note">
          A README can claim anything. This check is derived from the deployed ABI and the real
          event history, so it fails loudly if a future change starts emitting an amount. Read the{" "}
          <Ext href={scan(A.pool)}>verified source</Ext> and you can confirm the other half by eye:{" "}
          <code className="font-mono text-[12.5px]">allowPublicDecryption</code> appears exactly
          twice, both times on an epoch total.
        </Callout>
      </Section>

      <NextUp href="/analytics" label="Execution analytics" />
    </>
  );
}
