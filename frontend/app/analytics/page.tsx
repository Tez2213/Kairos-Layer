"use client";

import Link from "next/link";
import {
  Badge,
  Callout,
  NextUp,
  Panel,
  PanelHead,
  PageHeader,
  Section,
  Stat,
} from "@/components/ui";
import { Figure } from "@/components/diagrams";
import { useRecentEpochs, useUniswapDepth } from "@/lib/hooks";
import { epochSavings, sumSavings, type EpochSavings } from "@/lib/analytics";
import { QUOTE } from "@/lib/chain";
import { fmtUnits } from "@/lib/format";

export default function Analytics() {
  const [rows] = useRecentEpochs(12);
  const [depth] = useUniswapDepth();

  // Quote units per 1e18 base, from live pool balances.
  const price =
    depth && depth.weth > 0n ? (depth.usdc * 10n ** 18n) / depth.weth : 0n;

  const settled =
    rows?.filter((r) => r.epoch.state === 5 && r.epoch.buyTotal + r.epoch.sellTotal > 0n) ?? [];

  const perEpoch: { id: bigint; s: EpochSavings }[] =
    depth && price > 0n
      ? settled.map((r) => ({
          id: r.id,
          s: epochSavings(r.epoch, { quote: depth.usdc, base: depth.weth }, price),
        }))
      : [];

  const total = sumSavings(perEpoch.map((p) => p.s));
  const maxSaved = perEpoch.reduce((m, p) => (p.s.totalSaved > m ? p.s.totalSaved : m), 0n);

  return (
    <>
      <PageHeader
        index="11 — Execution analytics"
        title="What netting is worth, in money."
        lede="Privacy is the point, but it is not the only benefit. Because matched orders never touch the curve, a batch pays fees and price impact on the residual alone. This page reconstructs what the same orders would have cost executed individually on the same pool."
      />

      <Section title="Cumulative" hint="across recent settled epochs">
        <Panel>
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-rule">
            <Stat
              label="Volume shielded"
              value={fmtUnits(total.crossedQuote, 6, 2)}
              unit={QUOTE.symbol}
              tone="sealed"
              sub="matched internally — no on-chain trace"
            />
            <Stat
              label="Fees avoided"
              value={fmtUnits(total.feeSaved, 6, 2)}
              unit={QUOTE.symbol}
              tone="sealed"
              sub="0.3% never paid on matched volume"
            />
            <Stat
              label="Impact avoided"
              value={fmtUnits(total.impactSaved, 6, 4)}
              unit={QUOTE.symbol}
              tone="sealed"
              sub="curve never moved for matched flow"
            />
            <Stat
              label="MEV surface hidden"
              value={fmtUnits(total.mevSurfaceHidden, 6, 0)}
              unit={QUOTE.symbol}
              tone="sealed"
              sub="notional never visible to a searcher"
            />
          </div>
        </Panel>
        <p className="text-[13px] text-ink-3 mt-3 leading-snug">
          Figures are computed from live pool reserves using a constant-product model, which
          understates concentrated V3 depth — so these are floors, not flattering estimates.
        </p>
      </Section>

      <Section title="How the comparison is built">
        <Figure caption="The counterfactual is not a strawman: it is exactly what these traders would have done without a dark pool — send the same orders to the same pool.">
          <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-rule min-w-[560px]">
            <div className="p-4">
              <Badge tone="exposed">Without Kairos</Badge>
              <p className="text-[13.5px] text-ink-2 leading-relaxed mt-2.5">
                Every buyer swaps their quote for base. Every seller swaps their base for quote.
                Each pays the 0.3% fee and pushes the curve, so each subsequent trader gets a
                slightly worse price. All sizes are public before and after.
              </p>
            </div>
            <div className="p-4">
              <Badge tone="sealed">With Kairos</Badge>
              <p className="text-[13.5px] text-ink-2 leading-relaxed mt-2.5">
                Buy and sell flow cancel out at one clearing price. Only the imbalance reaches the
                pool, so fee and impact are paid once, on a smaller amount. Nothing is public
                except the totals.
              </p>
            </div>
          </div>
        </Figure>
      </Section>

      <Section title="Per epoch">
        <Panel>
          <PanelHead>
            <span>Epoch · shielded · saved</span>
            <span>{perEpoch.length} settled</span>
          </PanelHead>
          {perEpoch.length === 0 && (
            <div className="px-4 py-6 text-[13.5px] text-ink-3">
              No settled epochs with flow yet.{" "}
              <Link href="/trade" className="underline underline-offset-2">
                Place an order
              </Link>{" "}
              to generate one.
            </div>
          )}
          {perEpoch.map(({ id, s }) => (
            <div key={id.toString()} className="px-4 py-3 border-b border-rule last:border-0">
              <div className="flex items-center justify-between gap-4 flex-wrap mb-2">
                <Link
                  href={`/epochs/${id}`}
                  className="font-mono text-[13px] underline decoration-rule-2 underline-offset-4"
                >
                  Epoch #{id.toString()}
                </Link>
                <div className="flex items-center gap-4 font-mono text-[12px]">
                  <span className="text-sealed">
                    {(s.privacyRatio * 100).toFixed(1)}% shielded
                  </span>
                  <span className="text-ink-2">
                    saved {fmtUnits(s.totalSaved, 6, 4)} {QUOTE.symbol}
                  </span>
                  <span className="text-ink-3">{s.savedBps} bps</span>
                </div>
              </div>
              {/* relative bar across epochs */}
              <div className="flex h-1.5 bg-paper-2">
                <div
                  className="bg-sealed/60"
                  style={{
                    width: maxSaved > 0n ? `${Number((s.totalSaved * 100n) / maxSaved)}%` : "0%",
                  }}
                />
              </div>
            </div>
          ))}
        </Panel>
      </Section>

      <Section title="Reading these numbers honestly">
        <div className="space-y-3">
          <Callout kind="note" title="Savings scale with balance, not with volume">
            A perfectly balanced epoch pays almost nothing to the market. A one-sided epoch saves
            nothing at all, because there is no opposing flow to cross against — it degrades
            gracefully into an ordinary batched swap. The number moves with how well the two sides
            match, which is exactly how a real dark pool behaves.
          </Callout>
          <Callout kind="warn" title="Who captures the saving">
            Today the matched volume clears at the pool mid-price, so the light side gets a
            fee-free fill and the heavy side absorbs the residual&apos;s cost. A production version
            would blend one clearing price across both sides. The total saving is real either way;
            its distribution is not yet even, and the{" "}
            <Link href="/faq" className="underline underline-offset-2">
              FAQ
            </Link>{" "}
            says so plainly.
          </Callout>
        </div>
      </Section>

      <NextUp href="/auditor" label="Compliance & disclosure" />
    </>
  );
}
