"use client";

import { Callout, NextUp, Panel, PanelHead, PageHeader, Section, Badge } from "@/components/ui";
import { Figure, LifecycleStrip, NettingBar, Step } from "@/components/diagrams";
import { usePoolConfig } from "@/lib/hooks";

export default function HowItWorks() {
  const [cfg] = usePoolConfig();
  const epochMins = cfg ? Number(cfg.epochDuration) / 60 : 3;

  return (
    <>
      <PageHeader
        index="02 — How it works"
        title="Six steps, start to finish."
        lede="A worked example: two people want to buy ETH, two want to sell it, and none of them wants to say how much. Here is exactly what happens, and where the privacy comes from."
      />

      <Section title="The lifecycle at a glance">
        <Figure caption="Read left to right. Green stages keep amounts encrypted; orange stages publish an aggregate.">
          <LifecycleStrip />
        </Figure>
      </Section>

      <Section title="Step by step">
        <Panel>
          <div className="px-4">
            <Step n={1} title="Your browser encrypts the amount" tone="sealed">
              You type “1,000”. Before anything is sent, the Nox SDK encrypts it and returns a{" "}
              <em>handle</em> — a 32-byte pointer — plus a proof that the handle is genuinely yours.
              The number itself never leaves your machine. This matters because calldata is
              permanent public record: encrypting inside the contract would be too late.
            </Step>
            <Step n={2} title="You submit the handle, not the number" tone="sealed">
              The contract receives <code className="font-mono text-[12.5px]">(handle, proof)</code>
              , verifies the proof, and pulls your confidential tokens. It records the{" "}
              <strong>actually transferred</strong> amount, which matters: if your balance was too
              low, a confidential transfer silently moves zero rather than reverting, and crediting
              the requested amount would let someone claim funds they never deposited.
            </Step>
            <Step n={3} title="The epoch collects orders" tone="sealed">
              Orders accumulate for {epochMins} minutes. The contract keeps a running{" "}
              <em>encrypted</em> sum per side — it can add ciphertext without ever seeing the
              values. Nobody, including the contract, knows the totals yet.
            </Step>
            <Step n={4} title="Sealing reveals two numbers — and only two" tone="exposed">
              When the window closes, the epoch is sealed and exactly two handles are marked
              publicly decryptable: the buy-side total and the sell-side total. Every individual
              order handle stays private forever. If either side has fewer than{" "}
              {cfg ? cfg.minOrders : 2} participants the contract refuses, cancels the epoch and
              refunds everyone — a two-person “aggregate” would give the game away.
            </Step>
            <Step n={5} title="The sides cancel out; only the difference trades" tone="exposed">
              Say buyers brought 1,500 tUSDC and sellers brought ETH worth 609 tUSDC. Those 609 are
              matched internally at the pool price and never touch the market. Only the 891 tUSDC
              difference is swapped on Uniswap, as a single anonymous aggregate order.
            </Step>
            <Step n={6} title="You claim, and the maths stays encrypted" tone="sealed">
              Your payout is <code className="font-mono text-[12.5px]">yourOrder × total out ÷ total in</code>
              , computed inside the enclave on encrypted values. The result lands as a confidential
              balance only you can decrypt. Claims are pull-based, so one person’s inactivity never
              blocks anyone else.
            </Step>
          </div>
        </Panel>
      </Section>

      <Section title="A worked number" hint="from a real settled epoch on Sepolia">
        <Panel>
          <PanelHead>
            <span>Epoch 3 · 2 buyers · 2 sellers</span>
            <Badge tone="sealed">settled</Badge>
          </PanelHead>
          <div className="p-4">
            <NettingBar
              matched={609.02}
              residual={890.98}
              matchedLabel="609.02 tUSDC"
              residualLabel="890.98 tUSDC"
            />
          </div>
          <div className="border-t border-rule px-4 py-3 text-[13.5px] text-ink-2 leading-relaxed">
            Four orders went in — 1,000 and 500 tUSDC of buying, 0.2 and 0.1 tWETH of selling. The
            public chain learned two totals and saw one 890.98 tUSDC swap. It never learned that
            the buy side was split 1,000/500, and{" "}
            <strong className="text-ink font-medium">40.6% of the volume never appeared at all</strong>
            .
          </div>
        </Panel>
      </Section>

      <Section title="Where the privacy actually comes from">
        <div className="grid md:grid-cols-2 gap-px bg-rule border border-rule">
          {[
            {
              t: "Encryption",
              d: "Amounts are ciphertext everywhere: in calldata, in storage, in events. The chain stores pointers, and computation happens inside an Intel TDX enclave.",
              tone: "sealed" as const,
            },
            {
              t: "Aggregation",
              d: "Even the numbers we do publish are sums. With enough participants a total tells you nothing about any individual — which is why there is a minimum.",
              tone: "sealed" as const,
            },
            {
              t: "Netting",
              d: "Matched volume is not merely hidden, it is absent. There is no transaction to analyse because no transaction was ever made.",
              tone: "sealed" as const,
            },
            {
              t: "Batching",
              d: "One clearing price per epoch means no ordering advantage inside a batch. There is no first or last order to exploit.",
              tone: "sealed" as const,
            },
          ].map((c) => (
            <div key={c.t} className="bg-card p-4">
              <Badge tone={c.tone}>{c.t}</Badge>
              <p className="text-[13.5px] text-ink-2 leading-relaxed mt-2.5">{c.d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="The part people get wrong">
        <Callout kind="warn" title="Settlement is asynchronous, and that is by design">
          Decrypting a total requires a round trip to the enclave, which takes tens of seconds on a
          live network. So settlement is not one transaction — it is a small state machine that
          anyone may drive, with timeouts at every stage that refund users if a step never
          completes. You can watch it happen on the{" "}
          <a href="/settle" className="underline underline-offset-2">
            settlement desk
          </a>
          .
        </Callout>
      </Section>

      <NextUp href="/privacy" label="Privacy model" />
    </>
  );
}
