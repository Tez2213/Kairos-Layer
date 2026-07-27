"use client";

import { Badge, Callout, NextUp, Panel, PanelHead, PageHeader, Section } from "@/components/ui";
import { Figure, StateMachine } from "@/components/diagrams";
import { usePoolConfig } from "@/lib/hooks";

const FINDINGS = [
  {
    sev: "critical",
    title: "Deployment liquidity would have wedged every settlement",
    found:
      "The deploy script seeded 500× less liquidity than the test suite. The slippage bound caps a swap at roughly 2.8% of pool depth, which made the maximum settleable residual about 11 tUSDC — the demo scenario would have reverted every time.",
    fix: "Deployment now seeds the exact configuration the tests prove, giving ~5,500 tUSDC of headroom per residual.",
  },
  {
    sev: "critical",
    title: "Write-off could destroy a one-sided batch",
    found:
      "The last-resort hatch settled an epoch on its internal cross only. For a batch with orders on just one side that cross is zero, so every participant would have been marked paid while receiving nothing, with no way back.",
    fix: "It now refuses to run when the residual is still recoverable, or when the write-off would leave a funded side at zero — and claiming refuses to consume a position for a zero payout.",
  },
  {
    sev: "high",
    title: "A safety fix had introduced a denial-of-service",
    found:
      "An earlier revision serialised settlements to keep funds attributable. That let anyone park a batch mid-settlement and block every other batch for hours, repeatedly, at the cost of gas — with their own deposit fully refunded.",
    fix: "Replaced with per-token escrow accounting that attributes each residual exactly, so batches no longer need to serialise at all.",
  },
  {
    sev: "high",
    title: "The slippage guard did not guard against sandwiching",
    found:
      "The minimum-output bound was derived from the pool price read in the same transaction as the swap, so it moved with any manipulation and bounded nothing.",
    fix: "Both the internal cross and the swap now require spot to sit within a tick band of the pool's own time-weighted average, and the caller supplies a bound that can only tighten the on-chain floor.",
  },
  {
    sev: "high",
    title: "Small batches published individual orders",
    found:
      "With one participant on a side, the 'aggregate' the contract published was that person's exact order — quietly breaking the core promise.",
    fix: "Sealing now refuses to reveal a side below the participant floor and cancels the epoch for full refunds instead.",
  },
  {
    sev: "medium",
    title: "Deadlines could be moved after the fact",
    found:
      "Escape-hatch timeouts read live parameters, so the owner could shorten or extend them for batches already in flight; a newly appointed auditor also gained read access to historic orders.",
    fix: "Every epoch snapshots its timeouts, bounds, privacy floor and auditor when it opens.",
  },
];

const INVARIANTS = [
  ["Amounts never appear in the clear", "No plaintext order size in calldata, storage, events or logs. Encryption happens client-side only."],
  ["Only aggregates are ever published", "Public decryption is called on exactly two handles per epoch, and only above the participant floor."],
  ["No state can strand funds", "Every reachable state has an exit that returns deposits or pays out; all are permissionless and time-locked."],
  ["One batch cannot spend another's money", "Pending residuals are escrowed per token; every consumption path proves the balance covers all outstanding escrows."],
  ["Settlement cannot be forged", "Totals enter the chain only via enclave-signed proofs that the contract verifies."],
  ["Payouts round toward the pool", "Division truncates, so the contract can never be left short and the last claimant is always payable."],
];

export default function Security() {
  const [cfg] = usePoolConfig();

  return (
    <>
      <PageHeader
        index="13 — Security"
        title="What we broke before you could."
        lede="This contract was reviewed adversarially from four independent angles — economics, state machine, cryptographic access control, and the Uniswap integration. Everything below was found and fixed before deployment. Publishing the failures is more useful than claiming there were none."
      />

      <Section title="Findings" hint="all fixed and re-tested">
        <div className="space-y-3">
          {FINDINGS.map((f) => (
            <Panel key={f.title}>
              <PanelHead>
                <span className="normal-case tracking-normal font-sans text-[14px] text-ink font-medium">
                  {f.title}
                </span>
                <Badge tone={f.sev === "critical" ? "exposed" : f.sev === "high" ? "warn" : "muted"}>
                  {f.sev}
                </Badge>
              </PanelHead>
              <div className="p-4 grid md:grid-cols-2 gap-4">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-exposed mb-1.5">
                    The problem
                  </div>
                  <p className="text-[13.5px] text-ink-2 leading-relaxed">{f.found}</p>
                </div>
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-sealed mb-1.5">
                    The fix
                  </div>
                  <p className="text-[13.5px] text-ink-2 leading-relaxed">{f.fix}</p>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      </Section>

      <Section title="Invariants the code holds">
        <div className="border border-rule">
          {INVARIANTS.map(([t, d], i) => (
            <div
              key={t}
              className="flex gap-4 px-4 py-3 border-b border-rule last:border-0 items-start"
            >
              <span className="font-mono text-[11px] tnum text-ink-3 mt-0.5">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <div className="font-medium text-[14px]">{t}</div>
                <p className="text-[13px] text-ink-2 leading-snug mt-0.5">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Liveness by construction">
        <Figure caption="Every dashed path is an escape hatch. They are permissionless — you never need the operator's cooperation to get your money back.">
          <StateMachine />
        </Figure>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-rule border border-rule mt-4">
          {[
            ["Sealing stops working", "cancel the open epoch", `after window + ${cfg ? Number(cfg.revealTimeout) / 60 : 60} min`],
            ["Proofs never arrive", "cancel and refund", `after ${cfg ? Number(cfg.revealTimeout) / 60 : 60} min`],
            ["Swap cannot clear", "re-wrap and refund", `after ${cfg ? Number(cfg.unwrapTimeout) / 60 : 15} min`],
            ["Enclave goes dark", "pay out the matched part", `after ${cfg ? (Number(cfg.unwrapTimeout) * 3) / 60 : 45} min`],
          ].map(([sit, act, when]) => (
            <div key={sit} className="bg-card px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                {sit}
              </div>
              <div className="text-[13.5px] font-medium mt-1">{act}</div>
              <div className="text-[12px] text-ink-3 mt-0.5">{when}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="How it was tested">
        <div className="grid md:grid-cols-3 gap-px bg-rule border border-rule">
          {[
            {
              t: "Local enclave stack",
              d: "Nine integration tests run against a real Nox trusted-execution stack in Docker — real encryption, not mocks. They cover the full state machine, every escape hatch, multi-party netting and cross-transaction access control.",
            },
            {
              t: "Live network",
              d: "The complete flow was executed end-to-end on Sepolia with four independent wallets: encrypted orders, netting, a real Uniswap swap, pro-rata claims, and a verified failed decryption by a non-owner.",
            },
            {
              t: "Adversarial review",
              d: "Four independent reviews, each restricted to one dimension so findings could not hide behind a generalist skim. Each finding was reproduced before being fixed.",
            },
          ].map((c) => (
            <div key={c.t} className="bg-card p-4">
              <div className="font-display text-[1.25rem] mb-1.5">{c.t}</div>
              <p className="text-[13px] text-ink-2 leading-relaxed">{c.d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="What we are not claiming">
        <div className="space-y-3">
          <Callout kind="warn" title="Not professionally audited">
            This is hackathon software on a testnet. It has been reviewed carefully and tested
            hard, but it has not had a professional audit and should not hold real value.
          </Callout>
          <Callout kind="warn" title="Hardware trust, not cryptographic trust">
            Confidentiality depends on Intel TDX attestation and iExec&apos;s key management. That
            is a weaker assumption than zero-knowledge proofs, traded for the ability to compute
            arbitrarily on encrypted state.
          </Callout>
          <Callout kind="warn" title="Participant counts are an upper bound">
            An order exceeding your balance moves zero but still registers, so the counts the
            privacy floor checks can be padded. A capital-weighted floor is the production fix.
          </Callout>
        </div>
      </Section>

      <NextUp href="/contracts" label="Contracts" />
    </>
  );
}
