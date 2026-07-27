"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  Cipher,
  Input,
  NextUp,
  Panel,
  PanelHead,
  PageHeader,
  Section,
} from "@/components/ui";
import { useWallet, sendTx } from "@/lib/wallet";
import { useEpoch, useNow, usePoolConfig, usePosition, useWalletState } from "@/lib/hooks";
import { A, BASE, QUOTE } from "@/lib/chain";
import { KAIROS_POOL_ABI } from "@/lib/generated";
import { countdown, fmtUnits, parseUnits, revertReason, shortHandle } from "@/lib/format";
import { getHandleClient, ZERO_HANDLE } from "@/lib/nox";

export default function Trade() {
  const { address, walletClient, connect } = useWallet();
  const [cfg] = usePoolConfig();
  const [epoch, , refetchEpoch] = useEpoch(cfg?.currentEpochId);
  const [wallet] = useWalletState(address);
  const [pos, , refetchPos] = usePosition(cfg?.currentEpochId, address);
  const now = useNow();

  const [isBuy, setIsBuy] = useState(true);
  const [amount, setAmount] = useState("500");
  const [stage, setStage] = useState<"idle" | "encrypting" | "signing" | "sealing">("idle");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string }>();
  const [lastHandle, setLastHandle] = useState<string>();

  const token = isBuy ? QUOTE : BASE;
  const raw = parseUnits(amount, token.decimals);
  const isOperator = isBuy ? wallet?.opUsdc : wallet?.opWeth;
  const secondsLeft = epoch ? Number(epoch.endTime) - now : 0;
  const open = epoch?.state === 1 && secondsLeft > 0;
  const existing = isBuy ? pos?.buy : pos?.sell;
  const hasExisting = !!existing && existing !== ZERO_HANDLE;

  const submit = async () => {
    if (!walletClient || !address) return;
    setMsg(undefined);
    try {
      setStage("encrypting");
      const client = await getHandleClient(walletClient);
      const { handle, handleProof } = await client.encryptInput(raw, "uint256", A.pool);
      setLastHandle(handle);

      setStage("signing");
      await sendTx(walletClient, {
        address: A.pool,
        abi: KAIROS_POOL_ABI,
        functionName: "submitOrder",
        args: [isBuy, handle, handleProof],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);

      setMsg({ kind: "ok", text: "Order accepted. Your amount is encrypted on-chain." });
      refetchEpoch();
      refetchPos();
    } catch (e) {
      setMsg({ kind: "err", text: revertReason(e) });
    } finally {
      setStage("idle");
    }
  };

  /** Seal the expired batch so a fresh one opens — anyone may do this. */
  const openNextEpoch = async () => {
    if (!walletClient) return;
    setMsg(undefined);
    setStage("sealing");
    try {
      await sendTx(walletClient, {
        address: A.pool,
        abi: KAIROS_POOL_ABI,
        functionName: "seal",
        args: [],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
      setMsg({ kind: "ok", text: "New epoch open — you can place an order now." });
      refetchEpoch();
    } catch (e) {
      setMsg({ kind: "err", text: revertReason(e) });
    } finally {
      setStage("idle");
    }
  };

  const cancel = async () => {
    if (!walletClient) return;
    setMsg(undefined);
    try {
      setStage("signing");
      await sendTx(walletClient, {
        address: A.pool,
        abi: KAIROS_POOL_ABI,
        functionName: "cancelOrder",
        args: [isBuy],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
      setMsg({ kind: "ok", text: "Order cancelled and refunded confidentially." });
      refetchEpoch();
      refetchPos();
    } catch (e) {
      setMsg({ kind: "err", text: revertReason(e) });
    } finally {
      setStage("idle");
    }
  };

  const thin =
    epoch && cfg
      ? (isBuy ? epoch.buyCount : epoch.sellCount) + 1 < cfg.minOrders ||
        (isBuy ? epoch.sellCount : epoch.buyCount) === 0
      : false;

  return (
    <>
      <PageHeader
        index="06 — Place an order"
        title="Commit an amount nobody can read."
        lede="Your number is encrypted in this browser tab before the transaction is built. What reaches the chain is a 32-byte handle and a proof that it belongs to you."
      />

      <Section title="Current epoch" hint="orders are batched, not executed instantly">
        <Panel>
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-rule">
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                Epoch
              </div>
              <div className="font-mono tnum text-[15px] mt-1">
                #{cfg ? cfg.currentEpochId.toString() : "—"}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                {secondsLeft > 0 ? "Closes in" : "Order window"}
              </div>
              <div
                className={`font-mono tnum text-[15px] mt-1 ${
                  secondsLeft < 30 && secondsLeft > 0 ? "text-exposed pulse" : ""
                }`}
              >
                {epoch ? countdown(secondsLeft) : "—"}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                Buyers
              </div>
              <div className="font-mono tnum text-[15px] mt-1">{epoch?.buyCount ?? "—"}</div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                Sellers
              </div>
              <div className="font-mono tnum text-[15px] mt-1">{epoch?.sellCount ?? "—"}</div>
            </div>
          </div>
        </Panel>
        {epoch && epoch.state === 1 && secondsLeft <= 0 && (
          <div className="mt-3 border border-rule bg-card px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
            <p className="text-[13.5px] text-ink-2 max-w-[54ch]">
              This batch has closed. Opening the next one is permissionless — you can do it
              yourself right now for a few cents of gas, rather than waiting for a keeper.
            </p>
            {address ? (
              <Button onClick={openNextEpoch} busy={stage === "sealing"}>
                Open the next epoch
              </Button>
            ) : (
              <Button onClick={connect}>Connect wallet</Button>
            )}
          </div>
        )}
        {epoch && epoch.state !== 1 && (
          <p className="text-[13px] text-ink-3 mt-2">
            This epoch is settling. A fresh one opens as soon as it is sealed — follow along on the{" "}
            <Link href="/settle" className="underline underline-offset-2">
              settlement desk
            </Link>
            .
          </p>
        )}
      </Section>

      <Section title="Your order">
        <div className="grid grid-cols-2 gap-px bg-rule border border-rule mb-4">
          {[
            [true, `Buy ${BASE.symbol}`, `pay ${QUOTE.cSymbol}`],
            [false, `Sell ${BASE.symbol}`, `pay ${BASE.cSymbol}`],
          ].map(([v, t, d]) => (
            <button
              key={String(v)}
              onClick={() => setIsBuy(v as boolean)}
              className={`text-left px-4 py-3 transition-colors ${
                isBuy === v ? "bg-ink text-paper" : "bg-card hover:bg-paper-2"
              }`}
            >
              <div className="font-display text-[1.25rem] leading-tight">{t as string}</div>
              <div
                className={`font-mono text-[10.5px] uppercase tracking-[0.1em] mt-1 ${
                  isBuy === v ? "text-paper/60" : "text-ink-3"
                }`}
              >
                {d as string}
              </div>
            </button>
          ))}
        </div>

        <Panel>
          <PanelHead>
            <span>Amount — encrypted before sending</span>
            <Badge tone="sealed">private</Badge>
          </PanelHead>
          <div className="p-4">
            <div className="max-w-[320px]">
              <Input value={amount} onChange={setAmount} suffix={token.cSymbol} />
            </div>

            <div className="mt-4 grid sm:grid-cols-2 gap-4">
              <div className="border border-rule bg-paper-2/50 px-3 py-2.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1">
                  What you see
                </div>
                <div className="font-mono tnum text-[15px]">
                  {amount || "0"} {token.cSymbol}
                </div>
              </div>
              <div className="border border-sealed/25 bg-sealed-bg px-3 py-2.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-sealed mb-1">
                  What the chain sees
                </div>
                <div className="font-mono text-[15px] text-sealed">
                  {lastHandle ? shortHandle(lastHandle) : <Cipher width={10} />}
                </div>
              </div>
            </div>

            {!isOperator && address && (
              <Callout kind="warn" title="Authorisation missing">
                The pool is not yet an operator for your {token.cSymbol}. Grant it on the{" "}
                <Link href="/start" className="underline underline-offset-2">
                  get started
                </Link>{" "}
                page first — otherwise the transfer silently moves nothing.
              </Callout>
            )}

            {thin && open && (
              <div className="mt-4">
                <Callout kind="warn" title="Thin epoch — reduced anonymity">
                  With this few participants the published total reveals more than usual. The
                  contract will refuse to settle a side with fewer than {cfg?.minOrders} orders and
                  refund everyone instead. Consider waiting for company.
                </Callout>
              </div>
            )}

            <div className="mt-4 flex gap-3 flex-wrap items-center">
              {!address ? (
                <Button onClick={connect}>Connect wallet</Button>
              ) : (
                <Button
                  onClick={submit}
                  busy={stage !== "idle"}
                  disabled={!open || raw === 0n || !isOperator}
                >
                  {stage === "encrypting"
                    ? "Encrypting…"
                    : stage === "signing"
                      ? "Confirm in wallet…"
                      : "Encrypt & submit"}
                </Button>
              )}
              {hasExisting && open && (
                <Button onClick={cancel} variant="ghost" busy={stage === "signing"}>
                  Cancel my order
                </Button>
              )}
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
          </div>
        </Panel>
      </Section>

      {hasExisting && (
        <Section title="Your position in this epoch">
          <Panel>
            <div className="px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                  Committed {isBuy ? "buy" : "sell"} order
                </div>
                <div className="font-mono text-[13px] mt-1 text-sealed">
                  {shortHandle(existing)}
                </div>
              </div>
              <p className="text-[13px] text-ink-3 max-w-[40ch] leading-snug">
                Only you can decrypt this. Submitting again adds to it rather than replacing it.
              </p>
            </div>
          </Panel>
        </Section>
      )}

      <Section title="What happens next">
        <Panel>
          <div className="px-4 py-3.5 text-[13.5px] text-ink-2 leading-relaxed">
            When the timer hits zero anyone can seal the epoch. The two side totals are decrypted
            and proved on-chain, the sides are netted against each other, and only the difference
            is swapped on Uniswap. Then you come back and claim — your share is computed on
            encrypted values, so the payout is private too. Watch it happen live on the{" "}
            <Link href="/settle" className="underline underline-offset-2">
              settlement desk
            </Link>
            .
          </div>
        </Panel>
      </Section>

      <NextUp href="/balances" label="Your balances" />
    </>
  );
}
