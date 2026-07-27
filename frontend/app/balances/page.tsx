"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  Cipher,
  Ext,
  NextUp,
  Panel,
  PanelHead,
  PageHeader,
  Section,
} from "@/components/ui";
import { useWallet, sendTx } from "@/lib/wallet";
import { useRecentEpochs, useWalletState } from "@/lib/hooks";
import { A, BASE, QUOTE, scan, labelFor } from "@/lib/chain";
import { KAIROS_POOL_ABI } from "@/lib/generated";
import { fmtUnits, revertReason, shortHandle } from "@/lib/format";
import { decryptWithRetry, getHandleClient, ZERO_HANDLE } from "@/lib/nox";
import { publicClient } from "@/lib/chain";

export default function Balances() {
  const { address, walletClient, connect } = useWallet();
  const [wallet, , refetchWallet] = useWalletState(address);
  const [recent, , refetchEpochs] = useRecentEpochs(10);

  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string }>();

  const reveal = async (key: "cUSDC" | "cWETH") => {
    if (!walletClient || !wallet) return;
    const handle = key === "cUSDC" ? wallet.cUsdcHandle : wallet.cWethHandle;
    const decimals = key === "cUSDC" ? 6 : 18;
    if (handle === ZERO_HANDLE) {
      setRevealed((r) => ({ ...r, [key]: "0" }));
      return;
    }
    setBusy(key);
    try {
      const client = await getHandleClient(walletClient);
      const value = await decryptWithRetry(client, handle, { attempts: 12, delayMs: 3000 });
      setRevealed((r) => ({ ...r, [key]: fmtUnits(value, decimals, 6) }));
    } catch (e) {
      setMsg({ kind: "err", text: revertReason(e) });
    } finally {
      setBusy(undefined);
    }
  };

  // Epochs where this wallet holds a position that is claimable or refundable.
  const [claimable, setClaimable] = useState<
    { id: bigint; state: number; claimed: boolean }[] | undefined
  >();

  const scanPositions = async () => {
    if (!address || !recent) return;
    setBusy("scan");
    try {
      const rows = await Promise.all(
        recent.map(async ({ id, epoch }) => {
          const [buy, sell, claimed] = await Promise.all([
            publicClient.readContract({
              address: A.pool,
              abi: KAIROS_POOL_ABI,
              functionName: "orderOf",
              args: [id, address, true],
            }) as Promise<string>,
            publicClient.readContract({
              address: A.pool,
              abi: KAIROS_POOL_ABI,
              functionName: "orderOf",
              args: [id, address, false],
            }) as Promise<string>,
            publicClient.readContract({
              address: A.pool,
              abi: KAIROS_POOL_ABI,
              functionName: "claimed",
              args: [id, address],
            }) as Promise<boolean>,
          ]);
          const has = buy !== ZERO_HANDLE || sell !== ZERO_HANDLE;
          return has ? { id, state: epoch.state, claimed } : undefined;
        }),
      );
      setClaimable(rows.filter(Boolean) as { id: bigint; state: number; claimed: boolean }[]);
    } finally {
      setBusy(undefined);
    }
  };

  const claim = async (id: bigint, refund: boolean) => {
    if (!walletClient) return;
    setBusy(`claim-${id}`);
    setMsg(undefined);
    try {
      await sendTx(walletClient, {
        address: A.pool,
        abi: KAIROS_POOL_ABI,
        functionName: refund ? "claimRefund" : "claim",
        args: [id],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
      setMsg({ kind: "ok", text: `Epoch #${id} ${refund ? "refunded" : "claimed"}.` });
      setRevealed({});
      refetchWallet();
      refetchEpochs();
      void scanPositions();
    } catch (e) {
      setMsg({ kind: "err", text: revertReason(e) });
    } finally {
      setBusy(undefined);
    }
  };

  const cards = [
    {
      key: "cUSDC" as const,
      title: QUOTE.cSymbol,
      under: QUOTE.symbol,
      handle: wallet?.cUsdcHandle,
      addr: A.cUSDC,
      pub: wallet?.usdc,
      decimals: 6,
    },
    {
      key: "cWETH" as const,
      title: BASE.cSymbol,
      under: BASE.symbol,
      handle: wallet?.cWethHandle,
      addr: A.cWETH,
      pub: wallet?.weth,
      decimals: 18,
    },
  ];

  return (
    <>
      <PageHeader
        index="07 — Your balances"
        title="Encrypted by default. Readable only by you."
        lede="A confidential balance is a pointer, not a number. The value exists inside the enclave, and it is released only to addresses the access-control list names — which, for your balance, is you."
      />

      {!address && (
        <Section title="Connect to continue">
          <Panel>
            <div className="p-4 flex items-center justify-between gap-4 flex-wrap">
              <p className="text-[13.5px] text-ink-2">
                Decryption is authenticated with a signature from your wallet.
              </p>
              <Button onClick={connect}>Connect wallet</Button>
            </div>
          </Panel>
        </Section>
      )}

      <Section title="Confidential holdings">
        <div className="grid md:grid-cols-2 gap-4">
          {cards.map((c) => (
            <Panel key={c.key}>
              <PanelHead>
                <span>{c.title}</span>
                <Badge tone="sealed">encrypted</Badge>
              </PanelHead>
              <div className="p-4">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1.5">
                  On-chain representation
                </div>
                <div className="font-mono text-[12.5px] text-sealed break-all mb-4">
                  {c.handle ? shortHandle(c.handle) : "—"}
                </div>

                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1.5">
                  Plaintext value
                </div>
                <div className="font-mono tnum text-[1.6rem] leading-none mb-4">
                  {revealed[c.key] !== undefined ? (
                    <span>
                      {revealed[c.key]}{" "}
                      <span className="text-[0.55em] text-ink-3">{c.title}</span>
                    </span>
                  ) : (
                    <Cipher width={9} />
                  )}
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <Button
                    onClick={() => reveal(c.key)}
                    busy={busy === c.key}
                    disabled={!address}
                    variant={revealed[c.key] !== undefined ? "ghost" : "primary"}
                  >
                    {revealed[c.key] !== undefined ? "Decrypt again" : "Decrypt for me"}
                  </Button>
                  <span className="text-[12px] text-ink-3">
                    public {c.under}: {c.pub !== undefined ? fmtUnits(c.pub, c.decimals, 4) : "—"}
                  </span>
                </div>
              </div>
              <div className="border-t border-rule px-4 py-2">
                <Ext href={scan(c.addr)}>
                  <span className="font-mono text-[11px] text-ink-3">token contract ↗</span>
                </Ext>
              </div>
            </Panel>
          ))}
        </div>
        <p className="text-[13px] text-ink-3 mt-3 leading-snug">
          Decryption happens in your browser after an authenticated request to the enclave. The
          plaintext is never written back to the chain, and refreshing this page hides it again.
        </p>
      </Section>

      <Section title="Positions and claims" hint="epochs where you have funds">
        <Panel>
          <PanelHead>
            <span>Your epochs</span>
            <Button onClick={scanPositions} busy={busy === "scan"} disabled={!address} variant="ghost">
              Scan recent epochs
            </Button>
          </PanelHead>
          {claimable === undefined ? (
            <div className="px-4 py-5 text-[13.5px] text-ink-3">
              Scan to find epochs holding your orders.
            </div>
          ) : claimable.length === 0 ? (
            <div className="px-4 py-5 text-[13.5px] text-ink-3">
              No positions in the last 10 epochs.{" "}
              <Link href="/trade" className="underline underline-offset-2">
                Place an order
              </Link>
              .
            </div>
          ) : (
            <div>
              {claimable.map((row) => {
                const settled = row.state === 5;
                const cancelled = row.state === 6;
                return (
                  <div
                    key={row.id.toString()}
                    className="flex items-center justify-between gap-4 px-4 py-3 border-b border-rule last:border-0 flex-wrap"
                  >
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/epochs/${row.id}`}
                        className="font-mono text-[13px] underline decoration-rule-2 underline-offset-4"
                      >
                        Epoch #{row.id.toString()}
                      </Link>
                      <Badge tone={settled ? "sealed" : cancelled ? "exposed" : "muted"}>
                        {labelFor(row.state)}
                      </Badge>
                      {row.claimed && <Badge tone="muted">claimed</Badge>}
                    </div>
                    {!row.claimed && (settled || cancelled) && (
                      <Button
                        onClick={() => claim(row.id, cancelled)}
                        busy={busy === `claim-${row.id}`}
                      >
                        {cancelled ? "Claim refund" : "Claim payout"}
                      </Button>
                    )}
                    {!settled && !cancelled && (
                      <span className="text-[12.5px] text-ink-3">waiting for settlement</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

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

      <Section title="Getting money back out">
        <Callout kind="note" title="Unwrapping is deliberately two steps">
          Converting cUSDC back to tUSDC needs a plaintext amount, so the enclave must decrypt your
          burn first. You request an unwrap, the enclave produces a proof, and a second transaction
          releases the ERC-20. It is the one place where an amount you chose becomes public — which
          is why it is separate from trading.
        </Callout>
      </Section>

      <NextUp href="/epochs" label="Epochs" />
    </>
  );
}
