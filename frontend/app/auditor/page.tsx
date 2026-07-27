"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  Cipher,
  Ext,
  Field,
  Input,
  NextUp,
  Panel,
  PanelHead,
  PageHeader,
  Section,
} from "@/components/ui";
import { useWallet, sendTx } from "@/lib/wallet";
import { usePoolConfig, useRecentEpochs } from "@/lib/hooks";
import { A, QUOTE, BASE, scan } from "@/lib/chain";
import { KAIROS_POOL_ABI } from "@/lib/generated";
import { fmtUnits, revertReason, short, shortHandle } from "@/lib/format";
import { getHandleClient, ZERO_HANDLE } from "@/lib/nox";
import { publicClient } from "@/lib/chain";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export default function Auditor() {
  const { address, walletClient, connect } = useWallet();
  const [cfg, , refetchCfg] = usePoolConfig();
  const [rows] = useRecentEpochs(12);

  const [newAuditor, setNewAuditor] = useState("");
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string }>();
  const [disclosed, setDisclosed] = useState<
    { epochId: bigint; user: string; side: string; value: string }[]
  >([]);
  const [lookupEpoch, setLookupEpoch] = useState("");
  const [lookupUser, setLookupUser] = useState("");

  const isOwner = !!address && !!cfg && address.toLowerCase() === cfg.owner.toLowerCase();
  const isAuditor =
    !!address && !!cfg && cfg.auditor !== ZERO_ADDR &&
    address.toLowerCase() === cfg.auditor.toLowerCase();
  const auditorSet = !!cfg && cfg.auditor !== ZERO_ADDR;

  const setAuditor = async (to: string) => {
    if (!walletClient) return;
    setBusy("set");
    setMsg(undefined);
    try {
      await sendTx(walletClient, {
        address: A.pool,
        abi: KAIROS_POOL_ABI,
        functionName: "setAuditor",
        args: [to as `0x${string}`],
        account: walletClient.account!,
        chain: walletClient.chain,
      } as never);
      setMsg({
        kind: "ok",
        text:
          to === ZERO_ADDR
            ? "Auditor removed. Epochs opened from now on disclose nothing."
            : "Auditor appointed. It applies to epochs opened from now on — never to past ones.",
      });
      refetchCfg();
    } catch (e) {
      setMsg({ kind: "err", text: revertReason(e) });
    } finally {
      setBusy(undefined);
    }
  };

  /** As the auditor, decrypt one disclosed order. */
  const inspect = async () => {
    if (!walletClient || !lookupEpoch || !lookupUser) return;
    setBusy("inspect");
    setMsg(undefined);
    try {
      const epochId = BigInt(lookupEpoch);
      const client = await getHandleClient(walletClient);
      const results: typeof disclosed = [];
      for (const [side, isBuy] of [
        [`${QUOTE.cSymbol} buy order`, true],
        [`${BASE.cSymbol} sell order`, false],
      ] as [string, boolean][]) {
        const handle = (await publicClient.readContract({
          address: A.pool,
          abi: KAIROS_POOL_ABI,
          functionName: "orderOf",
          args: [epochId, lookupUser as `0x${string}`, isBuy],
        })) as `0x${string}`;
        if (handle === ZERO_HANDLE) continue;
        const { value } = await client.decrypt(handle);
        results.push({
          epochId,
          user: lookupUser,
          side,
          value: `${fmtUnits(value as bigint, isBuy ? 6 : 18, 6)} ${isBuy ? QUOTE.cSymbol : BASE.cSymbol}`,
        });
      }
      if (results.length === 0) {
        setMsg({ kind: "err", text: "That address holds no order in this epoch." });
      } else {
        setDisclosed((d) => [...results, ...d]);
      }
    } catch (e) {
      setMsg({
        kind: "err",
        text: `${revertReason(e)} — you are only granted access to epochs where you were the appointed auditor.`,
      });
    } finally {
      setBusy(undefined);
    }
  };

  const epochsWithAuditor = rows?.filter((r) => r.epoch.auditorSnap !== ZERO_ADDR) ?? [];

  return (
    <>
      <PageHeader
        index="12 — Compliance & disclosure"
        title="Confidential to the market. Legible to a regulator."
        lede="A venue that no supervisor can inspect is not deployable by a regulated institution. Kairos supports a scoped auditor: an address that may decrypt orders in the epochs it was appointed for — and nothing else, ever. Privacy without impunity."
      />

      <Section title="The rule, precisely">
        <div className="grid sm:grid-cols-3 gap-px bg-rule border border-rule">
          {[
            {
              t: "Scoped forward only",
              d: "Each epoch records its auditor when it opens. Appointing one today grants no access to yesterday's orders — a newly-appointed auditor cannot read history.",
            },
            {
              t: "Selective, never public",
              d: "Disclosure is a viewer grant to one address. Nothing becomes publicly decryptable, so the market still learns nothing.",
            },
            {
              t: "Irrevocable by design",
              d: "The Nox access list has no removeViewer. A grant is permanent, so appointing an auditor is a decision you cannot silently undo — we surface that rather than hide it.",
            },
          ].map((c) => (
            <div key={c.t} className="bg-card p-4">
              <div className="font-display text-[1.2rem] mb-1.5">{c.t}</div>
              <p className="text-[13px] text-ink-2 leading-relaxed">{c.d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Current appointment" hint="live from the contract">
        <Panel>
          <Field k="Auditor">
            {cfg ? (
              auditorSet ? (
                <Ext href={scan(cfg.auditor)}>{cfg.auditor}</Ext>
              ) : (
                <span className="text-ink-3">none — no epoch discloses anything</span>
              )
            ) : (
              "—"
            )}
          </Field>
          <Field k="Contract owner">{cfg ? short(cfg.owner, 6) : "—"}</Field>
          <Field k="You are">
            {!address
              ? "not connected"
              : [isOwner && "owner", isAuditor && "the auditor"].filter(Boolean).join(" · ") ||
                "an ordinary participant"}
          </Field>
        </Panel>
      </Section>

      {isOwner && (
        <Section title="Appoint an auditor" hint="owner only">
          <Panel>
            <PanelHead>
              <span>Governance action</span>
              <Badge tone="warn">applies to future epochs</Badge>
            </PanelHead>
            <div className="p-4">
              <p className="text-[13.5px] text-ink-2 mb-3 max-w-[64ch]">
                Set the address permitted to decrypt orders in epochs opened from now on. Use your
                own second wallet to try the flow end to end.
              </p>
              <div className="flex gap-3 flex-wrap items-center">
                <div className="w-[400px] max-w-full">
                  <Input value={newAuditor} onChange={setNewAuditor} placeholder="0x…" />
                </div>
                <Button
                  onClick={() => setAuditor(newAuditor)}
                  busy={busy === "set"}
                  disabled={!/^0x[a-fA-F0-9]{40}$/.test(newAuditor)}
                >
                  Appoint
                </Button>
                {auditorSet && (
                  <Button onClick={() => setAuditor(ZERO_ADDR)} variant="danger" busy={busy === "set"}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          </Panel>
        </Section>
      )}

      <Section title="Inspect a disclosed order" hint={isAuditor ? "you are the auditor" : "auditor only"}>
        <Panel>
          <PanelHead>
            <span>Supervisory lookup</span>
            {isAuditor ? <Badge tone="sealed">authorised</Badge> : <Badge tone="muted">not authorised</Badge>}
          </PanelHead>
          <div className="p-4">
            <p className="text-[13.5px] text-ink-2 mb-3 max-w-[64ch]">
              Enter an epoch and a participant. If you were the auditor for that epoch, the enclave
              releases the order size to you. If not — including for any epoch that predates your
              appointment — the request is refused.
            </p>
            <div className="flex gap-3 flex-wrap items-end">
              <div className="w-[120px]">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1">
                  Epoch
                </div>
                <Input value={lookupEpoch} onChange={setLookupEpoch} placeholder="3" />
              </div>
              <div className="w-[400px] max-w-full">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 mb-1">
                  Participant
                </div>
                <Input value={lookupUser} onChange={setLookupUser} placeholder="0x…" />
              </div>
              {address ? (
                <Button onClick={inspect} busy={busy === "inspect"} disabled={!lookupEpoch || !lookupUser}>
                  Request disclosure
                </Button>
              ) : (
                <Button onClick={connect}>Connect wallet</Button>
              )}
            </div>

            {disclosed.length > 0 && (
              <div className="mt-4 border border-sealed/25 bg-sealed-bg">
                <div className="px-3 py-2 border-b border-sealed/20 font-mono text-[10px] uppercase tracking-[0.12em] text-sealed">
                  Disclosed to you
                </div>
                {disclosed.map((d, i) => (
                  <div
                    key={i}
                    className="px-3 py-2 flex items-center justify-between gap-4 text-[13px] border-b border-sealed/15 last:border-0"
                  >
                    <span className="font-mono text-[12px]">
                      #{d.epochId.toString()} · {short(d.user, 5)} · {d.side}
                    </span>
                    <span className="font-mono tnum text-sealed">{d.value}</span>
                  </div>
                ))}
              </div>
            )}

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

      <Section title="Which epochs are supervised">
        <Panel>
          <PanelHead>
            <span>Auditor recorded per epoch</span>
            <span>{epochsWithAuditor.length} of {rows?.length ?? 0}</span>
          </PanelHead>
          {(rows ?? []).slice(0, 8).map(({ id, epoch }) => (
            <div
              key={id.toString()}
              className="px-4 py-2.5 border-b border-rule last:border-0 flex items-center justify-between gap-4"
            >
              <Link
                href={`/epochs/${id}`}
                className="font-mono text-[13px] underline decoration-rule-2 underline-offset-4"
              >
                Epoch #{id.toString()}
              </Link>
              {epoch.auditorSnap === ZERO_ADDR ? (
                <span className="font-mono text-[11.5px] text-ink-3">
                  no auditor — <Cipher width={5} /> sealed to everyone
                </span>
              ) : (
                <span className="font-mono text-[11.5px] text-warn">
                  supervised by {short(epoch.auditorSnap, 5)}
                </span>
              )}
            </div>
          ))}
        </Panel>
        <p className="text-[13px] text-ink-3 mt-3 leading-snug">
          The auditor is part of each epoch&apos;s immutable record, so a participant can check
          before they trade exactly who — if anyone — will be able to see their order.
        </p>
      </Section>

      <Section title="Why an institution needs this">
        <Callout kind="note">
          Every regulated venue must be able to answer a supervisor&apos;s question about a specific
          trade. A protocol that cannot do that is unusable by a bank, a fund or a licensed broker,
          no matter how good its cryptography. The distinction Kairos draws is between{" "}
          <em>confidential</em> and <em>unaccountable</em>: the market learns nothing, while a named
          supervisor can be granted a narrow, recorded, forward-only window.
        </Callout>
      </Section>

      <NextUp href="/security" label="Security" />
    </>
  );
}
