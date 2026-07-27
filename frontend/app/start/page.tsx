"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  Input,
  NextUp,
  Panel,
  PanelHead,
  PageHeader,
  Section,
  Ext,
} from "@/components/ui";
import { useWallet, sendTx } from "@/lib/wallet";
import { useWalletState } from "@/lib/hooks";
import { A, BASE, QUOTE, scan } from "@/lib/chain";
import { CTOKEN_ABI, ERC20_ABI } from "@/lib/generated";
import { fmtUnits, parseUnits, revertReason } from "@/lib/format";

type Side = "quote" | "base";

export default function Start() {
  const { address, walletClient, connect, wrongChain, switchChain } = useWallet();
  const [wallet, , refetch] = useWalletState(address);
  const [amount, setAmount] = useState("1000");
  const [side, setSide] = useState<Side>("quote");
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string }>();

  const token = side === "quote" ? QUOTE : BASE;
  const tokenAddr = side === "quote" ? A.usdc : A.weth;
  const cTokenAddr = side === "quote" ? A.cUSDC : A.cWETH;
  const publicBal = side === "quote" ? wallet?.usdc : wallet?.weth;
  const isOperator = side === "quote" ? wallet?.opUsdc : wallet?.opWeth;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMsg(undefined);
    try {
      await fn();
      setMsg({ kind: "ok", text: `${label} confirmed.` });
      refetch();
    } catch (e) {
      setMsg({ kind: "err", text: revertReason(e) });
    } finally {
      setBusy(undefined);
    }
  };

  const raw = parseUnits(amount, token.decimals);

  const faucet = () =>
    run("Mint", async () => {
      if (!walletClient) throw new Error("connect a wallet");
      await sendTx(walletClient, {
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "faucet",
        args: [raw],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
    });

  const wrap = () =>
    run("Wrap", async () => {
      if (!walletClient) throw new Error("connect a wallet");
      await sendTx(walletClient, {
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [cTokenAddr, raw],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
      await sendTx(walletClient, {
        address: cTokenAddr,
        abi: CTOKEN_ABI,
        functionName: "wrap",
        args: [address, raw],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
    });

  const authorise = () =>
    run("Authorise", async () => {
      if (!walletClient) throw new Error("connect a wallet");
      const until = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
      await sendTx(walletClient, {
        address: cTokenAddr,
        abi: CTOKEN_ABI,
        functionName: "setOperator",
        args: [A.pool, until],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
    });

  return (
    <>
      <PageHeader
        index="05 — Get started"
        title="Three transactions and you can trade privately."
        lede="Everything here is Sepolia testnet. Tokens are free, nothing has real value, and you need a little Sepolia ETH for gas."
      />

      {!address && (
        <Section title="First, connect">
          <Panel>
            <div className="p-4 flex items-center justify-between gap-4 flex-wrap">
              <p className="text-[13.5px] text-ink-2 max-w-[52ch]">
                This app talks to a wallet in your browser. Nothing is sent anywhere until you sign.
              </p>
              <Button onClick={connect}>Connect wallet</Button>
            </div>
          </Panel>
        </Section>
      )}

      {address && wrongChain && (
        <Section title="Wrong network">
          <Panel>
            <div className="p-4 flex items-center justify-between gap-4 flex-wrap">
              <p className="text-[13.5px] text-ink-2">
                Kairos Layer is deployed on Ethereum Sepolia.
              </p>
              <Button onClick={switchChain}>Switch to Sepolia</Button>
            </div>
          </Panel>
        </Section>
      )}

      <Section title="Which side are you on?" hint="you can do both">
        <div className="grid grid-cols-2 gap-px bg-rule border border-rule">
          {(
            [
              ["quote", "I want to BUY tWETH", `deposit ${QUOTE.symbol}`],
              ["base", "I want to SELL tWETH", `deposit ${BASE.symbol}`],
            ] as [Side, string, string][]
          ).map(([s, t, d]) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`text-left p-4 transition-colors ${
                side === s ? "bg-ink text-paper" : "bg-card hover:bg-paper-2"
              }`}
            >
              <div className="font-display text-[1.3rem] leading-tight">{t}</div>
              <div
                className={`font-mono text-[11px] uppercase tracking-[0.1em] mt-1.5 ${
                  side === s ? "text-paper/60" : "text-ink-3"
                }`}
              >
                {d}
              </div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Your position" hint="live">
        <Panel>
          <div className="grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-rule">
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                Sepolia ETH
              </div>
              <div className="font-mono tnum text-[15px] mt-1">
                {wallet ? fmtUnits(wallet.eth, 18, 4) : "—"}
              </div>
              <div className="text-[11.5px] text-ink-3 mt-0.5">for gas</div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
                {token.symbol} (public)
              </div>
              <div className="font-mono tnum text-[15px] mt-1">
                {publicBal !== undefined ? fmtUnits(publicBal, token.decimals, 4) : "—"}
              </div>
              <div className="text-[11.5px] text-ink-3 mt-0.5">visible to everyone</div>
            </div>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-sealed">
                {token.cSymbol} (confidential)
              </div>
              <div className="font-mono text-[15px] mt-1 text-sealed">▓▓▓▓▓▓</div>
              <div className="text-[11.5px] text-ink-3 mt-0.5">
                <Link href="/balances" className="underline underline-offset-2">
                  decrypt on balances
                </Link>
              </div>
            </div>
          </div>
        </Panel>
      </Section>

      <Section title="The three steps">
        <div className="space-y-4">
          <Panel>
            <PanelHead>
              <span>Step 1 · Mint test tokens</span>
              <Badge tone="muted">public</Badge>
            </PanelHead>
            <div className="p-4">
              <p className="text-[13.5px] text-ink-2 mb-3 max-w-[64ch]">
                {token.symbol} is a free faucet token that exists only for this demo. Mint whatever
                you like — a few thousand {QUOTE.symbol}, or a fraction of a {BASE.symbol}.
              </p>
              <div className="flex gap-3 flex-wrap items-center">
                <div className="w-[220px]">
                  <Input value={amount} onChange={setAmount} suffix={token.symbol} />
                </div>
                <Button onClick={faucet} busy={busy === "Mint"} disabled={!address || raw === 0n}>
                  Mint
                </Button>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHead>
              <span>Step 2 · Wrap into confidential form</span>
              <Badge tone="sealed">privacy starts here</Badge>
            </PanelHead>
            <div className="p-4">
              <p className="text-[13.5px] text-ink-2 mb-3 max-w-[64ch]">
                Wrapping converts {token.symbol} into {token.cSymbol}, whose balances are encrypted
                handles. The wrap amount itself is public — so wrap more than you plan to trade and
                the link between deposit and order is broken.
              </p>
              <Button onClick={wrap} busy={busy === "Wrap"} disabled={!address || raw === 0n}>
                Approve &amp; wrap {amount || "0"} {token.symbol}
              </Button>
            </div>
          </Panel>

          <Panel>
            <PanelHead>
              <span>Step 3 · Authorise the pool</span>
              {isOperator ? <Badge tone="sealed">done</Badge> : <Badge tone="warn">required</Badge>}
            </PanelHead>
            <div className="p-4">
              <p className="text-[13.5px] text-ink-2 mb-3 max-w-[64ch]">
                ERC-7984 replaces allowances with time-boxed operators. You grant KairosPool
                permission to move {token.cSymbol} on your behalf, expiring in 30 days. It can only
                ever move what you explicitly commit to an order.
              </p>
              <Button
                onClick={authorise}
                busy={busy === "Authorise"}
                disabled={!address}
                variant={isOperator ? "ghost" : "primary"}
              >
                {isOperator ? "Renew authorisation" : "Authorise KairosPool"}
              </Button>
            </div>
          </Panel>
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
      </Section>

      <Section title="Need gas?">
        <Callout kind="note">
          Sepolia ETH is free from the{" "}
          <Ext href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia">
            Google Cloud faucet
          </Ext>{" "}
          or{" "}
          <Ext href="https://sepoliafaucet.com">sepoliafaucet.com</Ext>. A full trade cycle costs
          well under 0.01 ETH. Token contracts:{" "}
          <Ext href={scan(A.usdc)}>{QUOTE.symbol}</Ext> · <Ext href={scan(A.weth)}>{BASE.symbol}</Ext>
          .
        </Callout>
      </Section>

      <NextUp href="/trade" label="Place an order" />
    </>
  );
}
