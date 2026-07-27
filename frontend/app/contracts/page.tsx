"use client";

import {
  Badge,
  Ext,
  Field,
  NextUp,
  Panel,
  PanelHead,
  PageHeader,
  Section,
  Callout,
} from "@/components/ui";
import { usePoolConfig, useUniswapDepth } from "@/lib/hooks";
import { A, BASE, QUOTE, scan } from "@/lib/chain";
import { fmtUnits, short } from "@/lib/format";

const CONTRACTS = [
  {
    name: "KairosPool",
    addr: A.pool,
    who: "ours",
    what: "The dark pool. Epochs, encrypted totals, netting, escrow, claims.",
  },
  { name: "cUSDC", addr: A.cUSDC, who: "ours", what: "Confidential ERC-7984 wrapper for tUSDC." },
  { name: "cWETH", addr: A.cWETH, who: "ours", what: "Confidential ERC-7984 wrapper for tWETH." },
  { name: "tUSDC", addr: A.usdc, who: "ours", what: "Faucet quote token, 6 decimals." },
  { name: "tWETH", addr: A.weth, who: "ours", what: "Faucet base token, 18 decimals." },
  {
    name: "Uniswap V3 pool",
    addr: A.uniPool,
    who: "Uniswap",
    what: "Canonical 0.3% pool. Receives the residual swap. Unmodified.",
  },
  {
    name: "Uniswap V3 factory",
    addr: A.factory,
    who: "Uniswap",
    what: "Canonical Sepolia factory that created the pool.",
  },
  {
    name: "NoxCompute",
    addr: A.noxCompute,
    who: "iExec",
    what: "Nox on-chain component: proof validation, handle access control, enclave triggers.",
  },
];

export default function Contracts() {
  const [cfg] = usePoolConfig();
  const [depth] = useUniswapDepth();

  // Slippage caps a swap at roughly maxSlippage−fee of the input reserve.
  const headroomBps = cfg ? Math.max(cfg.maxSlippageBps - 30, 0) : 270;
  const maxResidual = depth ? (depth.usdc * BigInt(headroomBps)) / 10_000n : undefined;

  return (
    <>
      <PageHeader
        index="14 — Contracts"
        title="Addresses, parameters, and how to check them yourself."
        lede="Everything is deployed on Ethereum Sepolia with verified source. Nothing on this page is asserted — each value is read live from the chain, and each address links to its verified code."
      />

      <Section title="Deployed addresses" hint="verified on Etherscan, Blockscout and Sourcify">
        <Panel>
          {CONTRACTS.map((c) => (
            <div
              key={c.name}
              className="px-4 py-3 border-b border-rule last:border-0 grid md:grid-cols-[150px_1fr] gap-2 md:gap-4"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-[14px]">{c.name}</span>
                <Badge tone={c.who === "ours" ? "ink" : "muted"}>{c.who}</Badge>
              </div>
              <div>
                <Ext href={scan(c.addr)}>
                  <span className="font-mono text-[12.5px] break-all">{c.addr}</span>
                </Ext>
                <p className="text-[12.5px] text-ink-3 mt-0.5 leading-snug">{c.what}</p>
              </div>
            </div>
          ))}
        </Panel>
      </Section>

      <Section title="Live parameters" hint="read from KairosPool right now">
        <div className="grid md:grid-cols-2 gap-4">
          <Panel>
            <PanelHead>
              <span>Batching</span>
            </PanelHead>
            <Field k="Current epoch">#{cfg ? cfg.currentEpochId.toString() : "—"}</Field>
            <Field k="Epoch length">
              {cfg ? `${Number(cfg.epochDuration) / 60} min` : "—"}
            </Field>
            <Field k="Privacy floor">
              {cfg ? `${cfg.minOrders} orders per side` : "—"}
            </Field>
            <Field k="Owner">{cfg ? short(cfg.owner, 6) : "—"}</Field>
            <Field k="Auditor">
              {cfg && cfg.auditor !== "0x0000000000000000000000000000000000000000"
                ? short(cfg.auditor, 6)
                : "none set"}
            </Field>
          </Panel>

          <Panel>
            <PanelHead>
              <span>Execution &amp; safety</span>
            </PanelHead>
            <Field k="Max slippage">{cfg ? `${cfg.maxSlippageBps / 100}%` : "—"}</Field>
            <Field k="TWAP window">
              {cfg ? (cfg.twapWindow === 0 ? "disabled" : `${cfg.twapWindow}s`) : "—"}
            </Field>
            <Field k="Max price deviation">
              {cfg ? `${cfg.maxTickDeviation} ticks (~${(cfg.maxTickDeviation / 100).toFixed(1)}%)` : "—"}
            </Field>
            <Field k="Reveal timeout">
              {cfg ? `${Number(cfg.revealTimeout) / 60} min` : "—"}
            </Field>
            <Field k="Unwrap timeout">
              {cfg ? `${Number(cfg.unwrapTimeout) / 60} min` : "—"}
            </Field>
          </Panel>
        </div>
      </Section>

      <Section title="Market depth" hint="determines the largest residual that can settle">
        <Panel>
          <div className="grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-rule">
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                {QUOTE.symbol} in pool
              </div>
              <div className="font-mono tnum text-[15px] mt-1">
                {depth ? fmtUnits(depth.usdc, 6, 0) : "—"}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                {BASE.symbol} in pool
              </div>
              <div className="font-mono tnum text-[15px] mt-1">
                {depth ? fmtUnits(depth.weth, 18, 3) : "—"}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-warn">
                Safe residual ceiling
              </div>
              <div className="font-mono tnum text-[15px] mt-1">
                {maxResidual ? `≈ ${fmtUnits(maxResidual, 6, 0)}` : "—"}
                <span className="text-[0.7em] text-ink-3 ml-1">{QUOTE.symbol}</span>
              </div>
            </div>
          </div>
        </Panel>
        <p className="text-[13px] text-ink-3 mt-3 leading-snug">
          The slippage bound limits a swap to roughly the pool&apos;s depth times the slippage
          allowance net of the 0.3% fee. A residual larger than that will refuse to execute — and
          the batch falls through to its refund path rather than trading at a bad price.
        </p>
      </Section>

      <Section title="Verify it yourself">
        <div className="space-y-3">
          <Callout kind="note" title="Read the source">
            Every contract above links to verified source on Etherscan. The privacy claim reduces to
            one thing you can check by eye: <code className="font-mono text-[12.5px]">allowPublicDecryption</code>{" "}
            appears exactly twice in KairosPool, both times on an epoch total. It is never called on
            an individual order.
          </Callout>
          <Callout kind="note" title="Watch the events">
            <Ext href={`${scan(A.pool)}#events`}>The event log</Ext> is the full public record of
            this protocol: epochs opening, orders arriving (address and direction, never amount),
            totals being revealed, and residuals being swapped.
          </Callout>
          <Callout kind="note" title="Check the swap">
            Compare a settled epoch&apos;s residual with the{" "}
            <Ext href={scan(A.uniPool)}>Uniswap pool&apos;s</Ext> token transfers. The amounts should
            match exactly — and the matched volume should be nowhere to be found, because it never
            existed on-chain.
          </Callout>
        </div>
      </Section>

      <NextUp href="/faq" label="FAQ" />
    </>
  );
}
