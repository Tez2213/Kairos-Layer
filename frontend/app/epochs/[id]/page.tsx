"use client";

import { use } from "react";
import Link from "next/link";
import {
  Badge,
  Callout,
  Cipher,
  Ext,
  Field,
  Panel,
  PanelHead,
  PageHeader,
  Section,
  Stat,
} from "@/components/ui";
import { NettingBar } from "@/components/diagrams";
import { useEpoch, useNow } from "@/lib/hooks";
import { A, BASE, EPOCH_STATES, QUOTE, RESIDUAL_KINDS, STATE_COPY, labelFor, scan } from "@/lib/chain";
import { countdown, fmtUnits, shortHandle } from "@/lib/format";

export default function EpochDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const epochId = BigInt(id);
  const [e] = useEpoch(epochId);
  const now = useNow();

  const settled = e?.state === 5;
  const hasFlow = !!e && e.buyTotal + e.sellTotal > 0n;
  const stateName = e ? EPOCH_STATES[e.state] : "—";
  const stateLabel = e ? labelFor(e.state) : "—";

  return (
    <>
      <PageHeader
        index={`Epoch #${id}`}
        title={`Batch #${id}`}
        lede={
          e ? (
            <>
              {STATE_COPY[stateName as keyof typeof STATE_COPY]}{" "}
              {e.state === 1 && <>Closes in {countdown(Number(e.endTime) - now)}.</>}
            </>
          ) : (
            "Loading from chain…"
          )
        }
      />

      <div className="mb-8">
        <Link
          href="/epochs"
          className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-ink-3 underline decoration-rule-2 underline-offset-4"
        >
          ← all epochs
        </Link>
      </div>

      <Section title="Headline">
        <Panel>
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-rule">
            <Stat label="State" value={stateLabel} />
            <Stat
              label="Participants"
              value={e ? e.buyCount + e.sellCount : "—"}
              sub={e ? `${e.buyCount} buy · ${e.sellCount} sell` : ""}
            />
            <Stat
              label="Privacy floor"
              value={e ? `${e.minOrdersSnap}/side` : "—"}
              tone="sealed"
              sub="snapshotted at open"
            />
            <Stat
              label="Netting"
              value={e ? RESIDUAL_KINDS[e.residual] : "—"}
              tone={e?.residual === 0 ? "sealed" : "exposed"}
            />
          </div>
        </Panel>
      </Section>

      {settled && hasFlow && (
        <Section title="Where the volume went">
          <Panel>
            <div className="p-4">
              <NettingBar
                matched={Number(e!.sellOutTotal)}
                residual={Number(e!.residualIn)}
                matchedLabel={`${fmtUnits(e!.sellOutTotal, 6, 2)} ${QUOTE.symbol}`}
                residualLabel={
                  e!.residual === 2
                    ? `${fmtUnits(e!.residualIn, 18, 5)} ${BASE.symbol}`
                    : `${fmtUnits(e!.residualIn, 6, 2)} ${QUOTE.symbol}`
                }
              />
            </div>
          </Panel>
          {e!.residual === 0 && (
            <div className="mt-3">
              <Callout kind="sealed" title="Perfect cross">
                The two sides matched exactly. Nothing at all was sent to Uniswap — this batch left
                no footprint on the public market.
              </Callout>
            </div>
          )}
        </Section>
      )}

      <Section title="Order book" hint="individual sizes are never stored in the clear">
        <div className="grid md:grid-cols-2 gap-4">
          <Panel>
            <PanelHead>
              <span>Buy side</span>
              <Badge tone="muted">{e?.buyCount ?? 0} participants</Badge>
            </PanelHead>
            <div className="p-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1">
                Encrypted total handle
              </div>
              <div className="font-mono text-[12px] text-sealed break-all mb-3">
                {e ? shortHandle(e.buyTotalEnc) : "—"}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1">
                Decrypted total
              </div>
              <div className="font-mono tnum text-[1.2rem]">
                {e && e.buyTotal > 0n ? (
                  <>
                    {fmtUnits(e.buyTotal, 6, 2)}{" "}
                    <span className="text-[0.6em] text-ink-3">{QUOTE.symbol}</span>
                  </>
                ) : e && e.state < 3 ? (
                  <Cipher width={8} />
                ) : (
                  "0"
                )}
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHead>
              <span>Sell side</span>
              <Badge tone="muted">{e?.sellCount ?? 0} participants</Badge>
            </PanelHead>
            <div className="p-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1">
                Encrypted total handle
              </div>
              <div className="font-mono text-[12px] text-sealed break-all mb-3">
                {e ? shortHandle(e.sellTotalEnc) : "—"}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1">
                Decrypted total
              </div>
              <div className="font-mono tnum text-[1.2rem]">
                {e && e.sellTotal > 0n ? (
                  <>
                    {fmtUnits(e.sellTotal, 18, 5)}{" "}
                    <span className="text-[0.6em] text-ink-3">{BASE.symbol}</span>
                  </>
                ) : e && e.state < 3 ? (
                  <Cipher width={8} />
                ) : (
                  "0"
                )}
              </div>
            </div>
          </Panel>
        </div>
        <p className="text-[13px] text-ink-3 mt-3 leading-snug">
          These two numbers are the <em>only</em> amounts this batch ever made public — and only
          after {e?.minOrdersSnap ?? 2} participants joined each side. The individual orders behind
          them remain encrypted permanently.
        </p>
      </Section>

      {settled && hasFlow && (
        <Section title="Payouts">
          <Panel>
            <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-rule">
              <Stat
                label="To buyers"
                value={fmtUnits(e!.buyOutTotal, 18, 5)}
                unit={BASE.cSymbol}
                sub="split pro-rata on encrypted values"
                tone="sealed"
              />
              <Stat
                label="To sellers"
                value={fmtUnits(e!.sellOutTotal, 6, 2)}
                unit={QUOTE.cSymbol}
                sub="split pro-rata on encrypted values"
                tone="sealed"
              />
            </div>
          </Panel>
          <p className="text-[13px] text-ink-3 mt-3 leading-snug">
            Each participant receives{" "}
            <code className="font-mono text-[12px]">their order × total out ÷ total in</code>,
            computed inside the enclave. The division rounds down, so any dust stays in the
            contract rather than leaving it short.
          </p>
        </Section>
      )}

      <Section title="Raw record" hint="straight from contract storage">
        <Panel>
          <Field k="Epoch id">#{id}</Field>
          <Field k="State">
            {stateLabel} ({e?.state ?? "—"})
          </Field>
          <Field k="Opened">
            {e ? new Date(Number(e.startTime) * 1000).toLocaleString() : "—"}
          </Field>
          <Field k="Window closes">
            {e ? new Date(Number(e.endTime) * 1000).toLocaleString() : "—"}
          </Field>
          <Field k="Sealed at">
            {e && e.sealedAt > 0n ? new Date(Number(e.sealedAt) * 1000).toLocaleString() : "—"}
          </Field>
          <Field k="Unwrap requested">
            {e && e.unwrapRequestedAt > 0n
              ? new Date(Number(e.unwrapRequestedAt) * 1000).toLocaleString()
              : "—"}
          </Field>
          <Field k="Residual kind">{e ? RESIDUAL_KINDS[e.residual] : "—"}</Field>
          <Field k="Residual amount">
            {e && e.residualIn > 0n
              ? e.residual === 2
                ? `${fmtUnits(e.residualIn, 18, 6)} ${BASE.symbol}`
                : `${fmtUnits(e.residualIn, 6, 2)} ${QUOTE.symbol}`
              : "0"}
          </Field>
          <Field k="Unwrap handle">{e ? shortHandle(e.unwrapRequestId) : "—"}</Field>
          <Field k="Slippage bound">{e ? `${e.maxSlippageBpsSnap / 100}%` : "—"}</Field>
          <Field k="Reveal timeout">{e ? `${Number(e.revealTimeoutSnap) / 60} min` : "—"}</Field>
          <Field k="Unwrap timeout">{e ? `${Number(e.unwrapTimeoutSnap) / 60} min` : "—"}</Field>
          <Field k="Auditor">
            {e && e.auditorSnap !== "0x0000000000000000000000000000000000000000"
              ? e.auditorSnap
              : "none"}
          </Field>
        </Panel>
        <p className="text-[13px] text-ink-3 mt-3">
          Timeouts and bounds are snapshotted when the epoch opens, so later parameter changes can
          never retroactively alter a batch already in flight.{" "}
          <Ext href={`${scan(A.pool)}#events`}>See on-chain events ↗</Ext>
        </p>
      </Section>
    </>
  );
}
