"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  Cipher,
  NextUp,
  Panel,
  PanelHead,
  PageHeader,
  Section,
} from "@/components/ui";
import { ExposureCompare, Figure } from "@/components/diagrams";
import { usePoolConfig, useRecentEpochs, useWalletState } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { getHandleClient, ZERO_HANDLE } from "@/lib/nox";
import { fmtUnits, revertReason, shortHandle } from "@/lib/format";
import { QUOTE } from "@/lib/chain";

export default function Privacy() {
  const [cfg] = usePoolConfig();
  const [recent] = useRecentEpochs(4);
  const { address, walletClient } = useWallet();
  const [wallet] = useWalletState(address);

  const [mine, setMine] = useState<string>();
  const [foreign, setForeign] = useState<string>();
  const [busy, setBusy] = useState<"mine" | "foreign">();

  // Demonstrate the ACL live: decrypt your own balance, then try someone else's.
  const decryptMine = async () => {
    if (!walletClient || !wallet || wallet.cUsdcHandle === ZERO_HANDLE) return;
    setBusy("mine");
    setMine(undefined);
    try {
      const client = await getHandleClient(walletClient);
      const { value } = await client.decrypt(wallet.cUsdcHandle);
      setMine(`${fmtUnits(value as bigint, 6, 6)} ${QUOTE.cSymbol}`);
    } catch (e) {
      setMine(`failed — ${revertReason(e)}`);
    } finally {
      setBusy(undefined);
    }
  };

  const strangerHandle = recent
    ?.flatMap((r) => [r.epoch.buyTotalEnc])
    .find((h) => h !== ZERO_HANDLE);

  const decryptForeign = async () => {
    if (!walletClient) return;
    setBusy("foreign");
    setForeign(undefined);
    try {
      const client = await getHandleClient(walletClient);
      // A handle you were never granted access to.
      const target = ("0x" + "11".repeat(32)) as `0x${string}`;
      await client.decrypt(target);
      setForeign("unexpectedly decrypted");
    } catch {
      setForeign("denied by the access-control list");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <PageHeader
        index="03 — Privacy model"
        title="What is hidden, and what is not."
        lede="Privacy claims are only useful if they are precise. This page states exactly which facts stay private, which are public by construction, and where the guarantee weakens."
      />

      <Section title="The ledger of exposure">
        <ExposureCompare />
        <p className="text-[13px] text-ink-3 mt-2.5 leading-snug">
          Note the third column is not all green. Participation and direction are public because
          they are ordinary contract calls — hiding those would require a different technique
          (relayers or mixers) and we would rather be accurate than impressive.
        </p>
      </Section>

      <Section title="Three mechanisms, stacked">
        <div className="space-y-px bg-rule border border-rule">
          {[
            {
              n: "Encryption",
              d: "Every amount is a Nox handle — a pointer to ciphertext held by the enclave. Arithmetic happens inside Intel TDX; the chain only ever stores 32-byte references.",
              gives: "Nobody reads your number.",
            },
            {
              n: "Aggregation",
              d: `Only per-side totals are ever decrypted, and only after ${cfg ? cfg.minOrders : 2}+ participants join that side. Otherwise the epoch cancels and refunds.`,
              gives: "A published number cannot be traced back to you.",
            },
            {
              n: "Netting",
              d: "Buy and sell flow cancel out before touching the market. Matched volume produces no transaction at all.",
              gives: "There is nothing to analyse, not even in aggregate.",
            },
          ].map((m) => (
            <div key={m.n} className="bg-card p-4 grid md:grid-cols-[150px_1fr_190px] gap-4">
              <Badge tone="sealed">{m.n}</Badge>
              <p className="text-[13.5px] text-ink-2 leading-relaxed">{m.d}</p>
              <p className="text-[13px] text-sealed leading-snug">{m.gives}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Try it yourself" hint="live against the deployed contract">
        <Panel>
          <PanelHead>
            <span>Access-control demonstration</span>
            {address ? <Badge tone="muted">wallet connected</Badge> : <Badge tone="warn">connect a wallet</Badge>}
          </PanelHead>
          <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-rule">
            <div className="p-4">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-sealed mb-2">
                Your own balance
              </div>
              <div className="text-[13.5px] text-ink-2 mb-3 leading-relaxed">
                The chain stores this as{" "}
                <span className="font-mono text-[12px]">
                  {wallet ? shortHandle(wallet.cUsdcHandle) : "—"}
                </span>
                . You hold the ACL grant, so the enclave will release it to you.
              </div>
              <Button onClick={decryptMine} busy={busy === "mine"} disabled={!address}>
                Decrypt my balance
              </Button>
              {mine && (
                <div className="mt-3 border border-sealed/25 bg-sealed-bg px-3 py-2 font-mono text-[13px] text-sealed">
                  {mine}
                </div>
              )}
            </div>
            <div className="p-4">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-exposed mb-2">
                A handle you do not own
              </div>
              <div className="text-[13.5px] text-ink-2 mb-3 leading-relaxed">
                Same enclave, same request, no grant. The access-control list is checked before any
                plaintext is released.
              </div>
              <Button
                onClick={decryptForeign}
                busy={busy === "foreign"}
                disabled={!address}
                variant="ghost"
              >
                Attempt foreign decrypt
              </Button>
              {foreign && (
                <div className="mt-3 border border-exposed/25 bg-exposed-bg px-3 py-2 font-mono text-[13px] text-exposed">
                  {foreign}
                </div>
              )}
            </div>
          </div>
        </Panel>
        {!address && (
          <p className="text-[13px] text-ink-3 mt-2">
            Connect a wallet and wrap a little tUSDC on the{" "}
            <Link href="/start" className="underline underline-offset-2">
              get started
            </Link>{" "}
            page to run this.
          </p>
        )}
      </Section>

      <Section title="How a value looks at each hop">
        <Figure caption="The same 1,000 tUSDC order, as seen by each party.">
          <div className="grid md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-rule min-w-[560px]">
            {[
              { who: "Your browser", val: "1,000.00", tone: "text-ink" },
              { who: "Calldata / events", val: null, tone: "" },
              { who: "Contract storage", val: null, tone: "" },
              { who: "Other traders", val: null, tone: "" },
            ].map((c) => (
              <div key={c.who} className="px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-2">
                  {c.who}
                </div>
                <div className={`font-mono tnum text-[15px] ${c.tone}`}>
                  {c.val ?? <Cipher width={8} />}
                </div>
              </div>
            ))}
          </div>
        </Figure>
      </Section>

      <Section title="Where the guarantee weakens">
        <div className="space-y-3">
          <Callout kind="warn" title="Small epochs leak">
            With one participant on a side, the “total” is that person’s order. The contract
            enforces a minimum of {cfg ? cfg.minOrders : 2} per side and cancels otherwise — but a
            two-person batch still lets each participant infer the other’s size by subtraction.
            More participants is strictly more privacy.
          </Callout>
          <Callout kind="warn" title="Participant counts can be inflated">
            An order that exceeds your balance silently transfers zero yet still registers as a
            participant. Someone could pad the count with empty orders to make a batch look busier
            than it is. A capital-weighted floor is the proper fix; today the count is an upper
            bound, and we say so.
          </Callout>
          <Callout kind="warn" title="Wrapping is public">
            Converting tUSDC into confidential cUSDC is an ordinary ERC-20 transfer, so the wrapped
            amount is visible. Privacy begins inside the confidential domain — wrap more than you
            intend to trade, and the link is broken.
          </Callout>
          <Callout kind="note" title="Trust assumption">
            Confidentiality rests on Intel TDX attestation and iExec&apos;s key-management service.
            This is hardware-based privacy, not cryptographic privacy — a different, weaker
            assumption than zero-knowledge, in exchange for general-purpose computation on
            encrypted state.
          </Callout>
        </div>
      </Section>

      <NextUp href="/architecture" label="Architecture" />
    </>
  );
}
