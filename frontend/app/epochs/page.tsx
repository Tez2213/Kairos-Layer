"use client";

import Link from "next/link";
import { Badge, NextUp, Panel, PanelHead, PageHeader, Section, Callout } from "@/components/ui";
import { useNow, usePoolConfig, useRecentEpochs } from "@/lib/hooks";
import { EPOCH_STATES, EPOCH_LABELS, QUOTE, BASE, STATE_COPY, labelFor } from "@/lib/chain";
import { countdown, fmtUnits } from "@/lib/format";

const toneFor = (state: number) =>
  state === 5 ? "sealed" : state === 6 ? "exposed" : state === 1 ? "ink" : "muted";

export default function Epochs() {
  const [cfg] = usePoolConfig();
  const [rows] = useRecentEpochs(12);
  const now = useNow();

  return (
    <>
      <PageHeader
        index="08 — Epochs"
        title="Every batch, and what it did or did not reveal."
        lede="An epoch is a fixed window that collects orders, then settles as a unit. This is the public record: totals, netting outcome, and the single swap that reached the market."
      />

      <Section title="Reading a row">
        <div className="grid sm:grid-cols-3 gap-px bg-rule border border-rule">
          {[
            ["Participants", "How many distinct addresses joined each side. More is more anonymity."],
            ["Crossed", "Volume matched internally between buyers and sellers — invisible to the market."],
            ["To Uniswap", "The residual imbalance, sent as one aggregate swap."],
          ].map(([t, d]) => (
            <div key={t} className="bg-card px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1">
                {t}
              </div>
              <p className="text-[13px] text-ink-2 leading-snug">{d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Recent epochs" hint={cfg ? `current #${cfg.currentEpochId}` : ""}>
        <Panel>
          <PanelHead>
            <span className="hidden sm:block">Epoch · state · participants · flow</span>
            <span className="sm:hidden">Epochs</span>
            <span>live</span>
          </PanelHead>

          {!rows && <div className="px-4 py-6 text-[13.5px] text-ink-3">Loading…</div>}

          {rows?.map(({ id, epoch }) => {
            const live = epoch.state === 1;
            const left = Number(epoch.endTime) - now;
            const settled = epoch.state === 5 && epoch.buyTotal + epoch.sellTotal > 0n;
            return (
              <Link
                key={id.toString()}
                href={`/epochs/${id}`}
                className="block border-b border-rule last:border-0 hover:bg-paper-2/60 transition-colors"
              >
                <div className="px-4 py-3 grid grid-cols-2 md:grid-cols-[110px_150px_1fr_auto] gap-3 items-center">
                  <div className="font-mono tnum text-[14px]">#{id.toString()}</div>

                  <div className="flex items-center gap-2">
                    <Badge tone={toneFor(epoch.state) as never}>
                      {labelFor(epoch.state)}
                    </Badge>
                    {live && (
                      <span
                        className={`font-mono text-[11px] tnum ${
                          left < 30 && left > 0 ? "text-exposed pulse" : "text-ink-3"
                        }`}
                      >
                        {countdown(left)}
                      </span>
                    )}
                  </div>

                  <div className="font-mono text-[12px] text-ink-3">
                    {epoch.buyCount}B / {epoch.sellCount}S
                    {settled && (
                      <span className="ml-3 text-sealed">
                        crossed {fmtUnits(epoch.sellOutTotal, 6, 2)} {QUOTE.symbol}
                      </span>
                    )}
                    {settled && epoch.residualIn > 0n && (
                      <span className="ml-3 text-exposed">
                        swap{" "}
                        {epoch.residual === 1
                          ? `${fmtUnits(epoch.residualIn, 6, 2)} ${QUOTE.symbol}`
                          : `${fmtUnits(epoch.residualIn, 18, 4)} ${BASE.symbol}`}
                      </span>
                    )}
                  </div>

                  <div className="font-mono text-[11px] text-ink-3 text-right hidden md:block">
                    inspect →
                  </div>
                </div>

                {/* proportion bar: crossed vs routed */}
                {settled && epoch.sellOutTotal + epoch.residualIn > 0n && (
                  <div className="px-4 pb-3">
                    <div className="flex h-1.5">
                      <div
                        className="bg-sealed/50"
                        style={{
                          width: `${
                            (Number(epoch.sellOutTotal) /
                              (Number(epoch.sellOutTotal) + Number(epoch.residualIn))) *
                            100
                          }%`,
                        }}
                      />
                      <div className="bg-exposed/40 flex-1" />
                    </div>
                  </div>
                )}
              </Link>
            );
          })}
        </Panel>
      </Section>

      <Section title="What each state means">
        <div className="border border-rule">
          {EPOCH_STATES.slice(1).map((s) => (
            <div
              key={s}
              className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-5 px-4 py-2.5 border-b border-rule last:border-0"
            >
              <div className="w-[130px] shrink-0">
                <Badge tone={s === "Distributable" ? "sealed" : s === "Cancelled" ? "exposed" : "muted"}>
                  {EPOCH_LABELS[s]}
                </Badge>
              </div>
              <p className="text-[13px] text-ink-2">{STATE_COPY[s]}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Why batches, not instant swaps">
        <Callout kind="note">
          A single order cannot hide in a crowd of one. Batching is what turns encryption into
          actual anonymity: your amount joins a total, and the total is all anyone sees. It also
          removes ordering advantage inside the batch — everyone clears at the same price, so there
          is nothing for a searcher to front-run.
        </Callout>
      </Section>

      <NextUp href="/settle" label="Settlement desk" />
    </>
  );
}
