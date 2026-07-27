"use client";

import Link from "next/link";
import { QUOTE, BASE, scan, A, labelFor } from "@/lib/chain";
import { fmtUnits, countdown } from "@/lib/format";
import { usePoolConfig, useRecentEpochs, useNow, useUniswapDepth } from "@/lib/hooks";
import {
  Badge,
  Callout,
  Ext,
  NextUp,
  Panel,
  Section,
  Stat,
  StatRow,
} from "@/components/ui";
import { Figure, LifecycleStrip, NettingBar } from "@/components/diagrams";

export default function Overview() {
  const [cfg] = usePoolConfig();
  const [recent] = useRecentEpochs(6);
  const [depth] = useUniswapDepth();
  const now = useNow();

  const current = recent?.[0];
  const settled = recent?.filter((r) => r.epoch.state === 5 && r.epoch.buyTotal > 0n) ?? [];
  const lastSettled = settled[0];

  // How much volume never reached the public market, across recent epochs.
  const crossed = settled.reduce((a, r) => a + r.epoch.sellOutTotal, 0n);
  const routed = settled.reduce((a, r) => a + r.epoch.residualIn, 0n);

  return (
    <>
      <header className="border-b border-rule pb-8 mb-10">
        <div className="font-mono text-[11px] tracking-[0.18em] text-ink-3 uppercase mb-4">
          01 — Overview
        </div>
        <h1 className="font-display text-[3.2rem] leading-[1.02] tracking-[-0.015em] mb-5 max-w-[18ch]">
          A dark pool for Ethereum.
        </h1>
        <p className="text-[17px] leading-relaxed text-ink-2 max-w-[64ch]">
          You submit a swap order and{" "}
          <strong className="font-medium text-ink">nobody sees the size</strong> — not the public
          chain, not other traders, not us. Orders in opposite directions are matched against each
          other inside a trusted enclave, and only the leftover imbalance is sent to Uniswap.
        </p>
        <div className="flex flex-wrap gap-2 mt-6">
          <Badge tone="sealed">Live on Sepolia</Badge>
          <Badge tone="muted">Built on iExec Nox</Badge>
          <Badge tone="muted">Uniswap V3 unmodified</Badge>
        </div>
      </header>

      <Section title="Live state" hint="read directly from the deployed contract">
        <StatRow>
          <Stat
            label="Current epoch"
            value={cfg ? `#${cfg.currentEpochId}` : "—"}
            sub={
              !current
                ? "loading"
                : current.epoch.state !== 1
                  ? labelFor(current.epoch.state)
                  : Number(current.epoch.endTime) - now > 0
                    ? `closes in ${countdown(Number(current.epoch.endTime) - now)}`
                    : "window ended · awaiting seal"
            }
          />
          <Stat
            label="Orders this epoch"
            value={current ? current.epoch.buyCount + current.epoch.sellCount : "—"}
            sub={
              current ? `${current.epoch.buyCount} buy · ${current.epoch.sellCount} sell` : "loading"
            }
          />
          <Stat
            label="Privacy floor"
            value={cfg ? `${cfg.minOrders}/side` : "—"}
            tone="sealed"
            sub="below this the epoch refuses to reveal"
          />
          <Stat
            label="Pool depth"
            value={depth ? fmtUnits(depth.usdc, 6, 0) : "—"}
            unit={QUOTE.symbol}
            sub={depth ? `${fmtUnits(depth.weth, 18, 2)} ${BASE.symbol} paired` : "loading"}
          />
        </StatRow>
      </Section>

      <Section title="What actually happens" hint="six steps — only two are public">
        <Figure
          caption={
            <>
              Steps 4 and 5 are the only ones that touch the public chain, and they carry{" "}
              <em>batch totals</em> exclusively. Your individual amount is encrypted before it
              leaves the browser and stays encrypted through the payout.
            </>
          }
        >
          <LifecycleStrip />
        </Figure>
      </Section>

      {lastSettled && (
        <Section title="Most recent settlement" hint={`epoch #${lastSettled.id}`}>
          <Panel>
            <div className="p-4">
              <NettingBar
                matched={Number(lastSettled.epoch.sellOutTotal)}
                residual={Number(lastSettled.epoch.residualIn)}
                matchedLabel={`${fmtUnits(lastSettled.epoch.sellOutTotal, 6, 2)} ${QUOTE.symbol}`}
                residualLabel={`${fmtUnits(lastSettled.epoch.residualIn, 6, 2)} ${QUOTE.symbol}`}
              />
            </div>
          </Panel>
          <div className="mt-3">
            <Link
              href={`/epochs/${lastSettled.id}`}
              className="font-mono text-[11.5px] uppercase tracking-[0.1em] underline decoration-rule-2 underline-offset-4 hover:decoration-ink"
            >
              Inspect this epoch →
            </Link>
          </div>
        </Section>
      )}

      {crossed > 0n && (
        <Section title="Cumulative effect" hint="across recent settled epochs">
          <Panel>
            <div className="grid grid-cols-2 divide-x divide-rule">
              <Stat
                label="Crossed off-book"
                value={fmtUnits(crossed, 6, 2)}
                unit={QUOTE.symbol}
                tone="sealed"
                sub="matched internally — never hit the public market"
              />
              <Stat
                label="Routed to Uniswap"
                value={fmtUnits(routed, 6, 2)}
                unit={QUOTE.symbol}
                tone="exposed"
                sub="unavoidable residual, sent as one aggregate swap"
              />
            </div>
          </Panel>
        </Section>
      )}

      <Section title="Why this matters">
        <div className="grid md:grid-cols-3 gap-px bg-rule border border-rule">
          {[
            {
              t: "Size is strategy",
              d: "On an ordinary DEX your order size is permanent public record. Anyone can reconstruct your position, your accumulation schedule and your conviction.",
            },
            {
              t: "Front-running needs a target",
              d: "A searcher cannot sandwich an order it cannot see. Batching also removes intra-epoch ordering — everyone in a batch clears at one price.",
            },
            {
              t: "Composability kept",
              d: "Kairos does not fork or wrap Uniswap. The residual is an ordinary swap against the canonical pool, so liquidity is never fragmented.",
            },
          ].map((c) => (
            <div key={c.t} className="bg-card p-4">
              <div className="font-display text-[1.3rem] mb-1.5">{c.t}</div>
              <p className="text-[13.5px] text-ink-2 leading-relaxed">{c.d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="What we are not claiming">
        <Callout kind="warn" title="Still visible to everyone">
          That <em>you</em> traded, and in which direction, is public — only amounts are hidden. In
          a thin epoch the batch total leaks more than in a busy one, which is exactly why the
          contract refuses to reveal a side with fewer than {cfg ? cfg.minOrders : 2} participants
          and refunds instead. Full detail on the{" "}
          <Link href="/privacy" className="underline underline-offset-2">
            privacy model
          </Link>{" "}
          page.
        </Callout>
      </Section>

      <Section title="Deployment">
        <Panel>
          <div className="px-4 py-3 text-[13px] flex flex-wrap items-center gap-x-8 gap-y-2">
            <span className="text-ink-3">Pool contract</span>
            <Ext href={scan(A.pool)}>
              <span className="font-mono text-[12.5px]">{A.pool}</span>
            </Ext>
          </div>
        </Panel>
      </Section>

      <NextUp href="/how-it-works" label="How it works" />
    </>
  );
}
