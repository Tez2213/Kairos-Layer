"use client";

import Link from "next/link";
import { Callout, Ext, Panel, PageHeader, Section } from "@/components/ui";
import { usePoolConfig } from "@/lib/hooks";

function QA({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-rule py-4 last:border-0">
      <div className="font-display text-[1.3rem] leading-snug mb-1.5">{q}</div>
      <div className="text-[13.5px] text-ink-2 leading-relaxed max-w-[72ch]">{children}</div>
    </div>
  );
}

export default function FAQ() {
  const [cfg] = usePoolConfig();

  return (
    <>
      <PageHeader
        index="15 — FAQ"
        title="The questions people actually ask."
        lede="Short answers, including to the awkward ones. If something here contradicts a claim elsewhere on the site, trust this page — it is the one written to be picked apart."
      />

      <Section title="The basics">
        <Panel>
          <div className="px-4">
            <QA q="Is my trade really private?">
              Your <em>amount</em> is. The fact that you traded and which direction you took are
              public, because those are ordinary contract calls. If you need to hide participation
              itself, this is the wrong tool — you would want a relayer on top. We would rather
              state the boundary than blur it.
            </QA>
            <QA q="Who can see my order size?">
              You, and anyone you explicitly grant access to. Not the operator, not other traders,
              not the sequencer, not us. The value lives inside a hardware enclave and the chain
              stores only a pointer.
            </QA>
            <QA q="Why do I have to wait for an epoch?">
              Because encryption alone is not anonymity. If your order settled instantly and alone,
              the resulting swap would be your order, plainly visible. Batching puts you in a crowd;
              netting means part of the volume never appears at all.
            </QA>
            <QA q="What if I am the only person trading?">
              The contract refuses to settle. Below {cfg ? cfg.minOrders : 2} participants on a side
              it cancels the epoch and refunds everyone rather than publishing a total that would
              reveal your order. Refusing to trade is the correct behaviour when privacy cannot be
              delivered.
            </QA>
          </div>
        </Panel>
      </Section>

      <Section title="Mechanics">
        <Panel>
          <div className="px-4">
            <QA q="What price do I get?">
              One clearing price for everyone in the batch, taken from the Uniswap pool and checked
              against its own time-weighted average so it cannot be manipulated in the moment.
              Matched volume clears at that price; the residual gets the pool&apos;s actual
              execution.
            </QA>
            <QA q="Who pays the swap fee?">
              The heavier side of the batch, spread pro-rata. If buyers outweigh sellers, buyers
              collectively absorb the fee and price impact of the leftover swap, while sellers get a
              clean mid-price fill. It is a real asymmetry and we would blend the price in a
              production version.
            </QA>
            <QA q="Can the operator steal or censor?">
              Every settlement step is permissionless — anyone can drive a batch forward, so nobody
              can hold one hostage. The owner can adjust parameters, but only for{" "}
              <em>future</em> epochs: each batch snapshots its own timeouts and bounds when it
              opens. The owner cannot touch escrowed funds.
            </QA>
            <QA q="What happens if the enclave goes down mid-settlement?">
              Timeouts. Depending on how far the batch got, it either cancels with full refunds or
              settles the matched portion and writes off only the unrecoverable residual. No state
              leaves funds stuck — that property was the main target of the security review.
            </QA>
            <QA q="Why is there a maximum order size?">
              The residual swap has to clear a slippage bound against real pool depth. On this
              testnet deployment that caps a residual at a few thousand tUSDC. Deeper liquidity
              raises the ceiling; see the{" "}
              <Link href="/contracts" className="underline underline-offset-2">
                contracts
              </Link>{" "}
              page for the live figure.
            </QA>
          </div>
        </Panel>
      </Section>

      <Section title="Sceptical questions">
        <Panel>
          <div className="px-4">
            <QA q="Is this just a mixer?">
              No. Funds never change ownership and there is no anonymity set to hop between. It is a
              dark pool: an execution venue where order sizes are confidential, which is ordinary
              market structure in traditional finance and simply missing on-chain.
            </QA>
            <QA q="Does it fork or wrap Uniswap?">
              Neither. The residual is a normal swap against the canonical pool through the standard
              interface. Liquidity is not fragmented and no Uniswap code was modified — that
              constraint shaped the whole design.
            </QA>
            <QA q="How is this different from a zero-knowledge system?">
              Different trust model. Zero-knowledge gives cryptographic guarantees but makes general
              computation on shared encrypted state hard. Nox uses hardware enclaves: weaker
              assumptions — you trust Intel TDX attestation and iExec&apos;s key management — in
              exchange for arithmetic on encrypted values with normal Solidity.
            </QA>
            <QA q="Could someone fake a batch total to steal funds?">
              No. Totals only enter the contract as enclave-signed proofs bound to a specific
              handle, verified on-chain. A malicious settler can stall a batch into its refund path,
              but cannot invent a number.
            </QA>
            <QA q="Is it audited?">
              Not professionally. It was reviewed adversarially across four dimensions, and the
              findings — including two that would have broken the deployment — are published in full
              on the{" "}
              <Link href="/security" className="underline underline-offset-2">
                security
              </Link>{" "}
              page. Treat it as testnet software.
            </QA>
          </div>
        </Panel>
      </Section>

      <Section title="Practical">
        <Panel>
          <div className="px-4">
            <QA q="Do I need a special wallet?">
              No. Any ordinary wallet works — MetaMask, Rabby, whatever you use. Encryption happens
              in the page via the Nox SDK, and you sign normal transactions.
            </QA>
            <QA q="Where do the tokens come from?">
              They are free faucet tokens that exist only for this demo and are worth nothing. Mint
              them on the{" "}
              <Link href="/start" className="underline underline-offset-2">
                get started
              </Link>{" "}
              page; you will need a little Sepolia ETH for gas.
            </QA>
            <QA q="Why did my decryption take so long?">
              Live enclave round trips take tens of seconds. The app polls until the value is ready
              rather than failing — that latency is the honest cost of computing on encrypted state,
              and it is why settlement is a queue of steps rather than one transaction.
            </QA>
          </div>
        </Panel>
      </Section>

      <Section title="Still curious">
        <Callout kind="note">
          The contracts are verified and readable on{" "}
          <Ext href="https://sepolia.etherscan.io">Etherscan</Ext>, and the whole protocol is
          described end to end in{" "}
          <Link href="/how-it-works" className="underline underline-offset-2">
            how it works
          </Link>
          . For the trust boundaries specifically, read the{" "}
          <Link href="/privacy" className="underline underline-offset-2">
            privacy model
          </Link>{" "}
          — it is deliberately the least flattering page on this site.
        </Callout>
      </Section>
    </>
  );
}
