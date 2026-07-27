"use client";

import { A, scan } from "@/lib/chain";
import { Badge, Ext, NextUp, Panel, PanelHead, PageHeader, Section, Callout } from "@/components/ui";
import { Figure, StackMap, StateMachine, Step } from "@/components/diagrams";

const COMPONENTS = [
  {
    name: "KairosPool",
    owner: "ours",
    role: "The only contract we wrote. Holds epochs, encrypted side totals, netting logic, per-token escrow accounting and pull-based claims.",
    addr: A.pool,
  },
  {
    name: "cUSDC / cWETH",
    owner: "ours",
    role: "ERC-7984 confidential wrappers. Deposit an ordinary ERC-20, receive a token whose balances and transfer amounts are encrypted handles.",
    addr: A.cUSDC,
  },
  {
    name: "NoxCompute",
    owner: "iExec",
    role: "On-chain half of Nox. Validates input proofs, manages the access-control list for every handle, and emits the events that trigger enclave computation.",
    addr: A.noxCompute,
  },
  {
    name: "Uniswap V3 pool",
    owner: "Uniswap",
    role: "The canonical 0.3% pool, entirely untouched. Receives one aggregate swap per epoch through the standard callback interface.",
    addr: A.uniPool,
  },
];

export default function Architecture() {
  return (
    <>
      <PageHeader
        index="04 — Architecture"
        title="One contract, composed with two systems we did not change."
        lede="The interesting engineering here is not a new AMM. It is adding confidentiality to infrastructure that is public by design, without forking it, wrapping it or fragmenting its liquidity."
      />

      <Section title="The stack">
        <Figure caption="Each layer talks only to its neighbours. Nox and Uniswap are used exactly as their authors intended.">
          <StackMap />
        </Figure>
      </Section>

      <Section title="What each piece does">
        <div className="space-y-px bg-rule border border-rule">
          {COMPONENTS.map((c) => (
            <div key={c.name} className="bg-card p-4">
              <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                <span className="font-display text-[1.25rem]">{c.name}</span>
                <Badge tone={c.owner === "ours" ? "ink" : "muted"}>{c.owner}</Badge>
                <Ext href={scan(c.addr)}>
                  <span className="font-mono text-[11.5px] text-ink-3">{c.addr.slice(0, 14)}…</span>
                </Ext>
              </div>
              <p className="text-[13.5px] text-ink-2 leading-relaxed max-w-[70ch]">{c.role}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="How a confidential value travels">
        <Panel>
          <div className="px-4">
            <Step n={1} title="Browser → handle gateway" tone="sealed">
              The SDK sends your plaintext to the gateway over TLS, where it is encrypted inside the
              enclave. You get back a handle and an EIP-712 proof binding it to your address and to
              this specific contract — so it cannot be replayed elsewhere.
            </Step>
            <Step n={2} title="Handle → KairosPool" tone="sealed">
              The contract calls <code className="font-mono text-[12.5px]">Nox.fromExternal</code>,
              which verifies the proof through NoxCompute. From here the contract can add, subtract,
              multiply and divide handles without ever seeing a value.
            </Step>
            <Step n={3} title="Contract → enclave" tone="sealed">
              Each operation emits an event. An off-chain ingestor picks it up, a runner executes
              the arithmetic inside Intel TDX, and the result is written back as a new handle. This
              is why settlement is asynchronous rather than atomic.
            </Step>
            <Step n={4} title="Enclave → the entitled reader" tone="sealed">
              Decryption is checked against the on-chain access-control list. Grants are transient
              by default and must be made persistent deliberately — a subtlety that, if missed,
              silently strands funds. Every handle this contract stores is granted explicitly.
            </Step>
          </div>
        </Panel>
      </Section>

      <Section title="The settlement state machine">
        <Figure caption="Solid arrows are the happy path. Dashed arrows are escape hatches — each one returns deposits in full, and every transition may be triggered by anyone.">
          <StateMachine />
        </Figure>
      </Section>

      <Section title="Two design decisions worth defending">
        <div className="grid md:grid-cols-2 gap-px bg-rule border border-rule">
          <div className="bg-card p-4">
            <div className="font-display text-[1.25rem] mb-1.5">No router dependency</div>
            <p className="text-[13.5px] text-ink-2 leading-relaxed">
              We call the Uniswap V3 pool directly and pay through the swap callback. One hop fewer,
              no periphery contract to trust, and it works identically on any chain where the core
              is deployed.
            </p>
          </div>
          <div className="bg-card p-4">
            <div className="font-display text-[1.25rem] mb-1.5">Pull, never push</div>
            <p className="text-[13.5px] text-ink-2 leading-relaxed">
              Payouts are claimed individually. Settlement therefore costs a fixed amount of gas
              regardless of participant count, and one unclaimable recipient can never block the
              batch — a failure mode that has broken real batch protocols.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Asynchrony is the hard part">
        <Callout kind="note" title="Why there is no single settle() button">
          Two steps need the enclave to answer: decrypting the side totals, and releasing the
          residual for the public swap. On a live network each round trip takes tens of seconds, so
          a single atomic transaction is impossible. The protocol is therefore a queue of
          permissionless, idempotent steps with timeouts — anyone can push it forward, and if
          nobody does, users get their money back.
        </Callout>
      </Section>

      <NextUp href="/start" label="Get started" />
    </>
  );
}
