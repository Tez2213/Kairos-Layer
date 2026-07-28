<p align="center">
  <img src="frontend/public/logo.png" alt="Kairos Layer" width="340">
</p>

<h1 align="center">Kairos Layer</h1>

<p align="center"><b>A dark pool for Ethereum.</b><br>
Submit a swap order and nobody sees the size — not the public chain, not other<br>
traders, not the operator. Orders in opposite directions are matched against each<br>
other inside a trusted enclave, and only the unmatched residual reaches Uniswap.</p>

<p align="center">
  <a href="https://kairos-layerr.vercel.app"><b>▶ Live app</b></a> ·
  <a href="https://sepolia.etherscan.io/address/0xfced18bc0ea5c90b6307f403aa0f21f291b7b7a5#code">Verified contract</a> ·
  <a href="https://kairos-layerr.vercel.app/proof">Zero-leakage proof</a> ·
  <a href="feedback.md">iExec feedback log</a>
</p>

<p align="center"><i>Built on <a href="https://docs.noxprotocol.io">iExec Nox</a> for the WTF Hackathon.
Live on Ethereum Sepolia. No mock data anywhere.</i></p>

---

## The problem

Every order on a public AMM is visible before it executes. Two costs follow, and both
are paid by the person who wanted to trade:

- **Front-running.** A searcher sees your pending swap, buys ahead of it, and sells it
  back to you at a worse price.
- **Price impact you announce in advance.** Size moves the curve, and everyone can see
  your size coming.

Institutional finance solved this with dark pools: venues where you can trade without
publishing your intent first. Ethereum has not had one, because a public state machine
cannot keep a secret.

## What Kairos does

It collects orders for a fixed window with the amounts encrypted, matches opposite
sides against each other at one clearing price inside a TEE, and sends **only the
imbalance** to Uniswap.

```
 encrypted orders          netted in the enclave         only the residual
   (amounts hidden)   →     at one clearing price    →    reaches Uniswap V3
```

**From a real settled batch on Sepolia — epoch #3, readable on-chain right now:**

| | |
| --- | --- |
| Buy orders collected | 1,500 tUSDC (2 participants) |
| Sell orders collected | 0.3 tWETH (2 participants) |
| **Matched internally** | **609.018601 tUSDC — never reached the public chain** |
| Sent to Uniswap | 890.981399 tUSDC, as one anonymous swap |

**40.6% of the buy-side flow left no on-chain trace at all.** Not obfuscated —
absent. There is no transaction to analyse because none was made.

### Why this is more than "encrypted swaps"

Encryption alone is not privacy. If your encrypted order settled instantly and alone,
the swap that appeared a second later *would be* your order, in plain sight. Kairos
stacks three mechanisms, and the third is the one that carries the weight:

1. **Encryption** — amounts are Nox handles. The chain stores pointers; arithmetic
   happens inside Intel TDX.
2. **Aggregation** — only per-side *totals* are ever decrypted, and only once enough
   participants have joined that a total hides them. Below that floor the epoch
   refuses to reveal and refunds instead.
3. **Netting** — matched volume is not hidden, it is *absent*.

And it composes rather than forks: the residual is an ordinary swap against the
canonical Uniswap V3 pool. Liquidity is never fragmented, and no Uniswap code was
modified or redeployed.

---

## How iExec Nox is used

Nox is not decoration here — the matching engine cannot exist without it.

| Nox primitive | What Kairos does with it |
| --- | --- |
| `Nox.fromExternal(handle, proof)` | Ingests an amount encrypted **in the browser**. Plaintext never appears in calldata, events, storage or logs. |
| `Nox.add` / `sub` / `mul` / `div` | Runs the entire netting computation on ciphertext — side totals, clearing price, pro-rata payouts. |
| `Nox.allowThis` / `allow` / `allowTransient` | Re-grants ACL after **every** operation that yields a handle. ACL is transient per transaction; a missed grant is a permanently bricked handle. |
| `Nox.allowPublicDecryption` | Applied **only** to epoch aggregate handles — never to a per-user handle. This boundary is the whole privacy model. |
| `Nox.publicDecrypt` | Reveals the two side totals, asynchronously, after the participant floor is met. |
| `Nox.addViewer` | Powers scoped auditor disclosure — see `/auditor`. |
| ERC-7984 + `ERC20ToERC7984Wrapper` | Confidential balances; users wrap ordinary ERC-20s in and out. |

Encrypted state is 28 `euint256` handles across the contract. Every arithmetic result
that a user must later read is ACL-granted and then **verified usable in a separate
transaction**, because same-transaction success proves nothing about durability.

**No plaintext branching on encrypted comparisons.** An order larger than your balance
does not revert — it moves zero, via select/safe-subtract semantics, so failure is
indistinguishable from a small order.

---

## Live deployment

**App:** https://kairos-layerr.vercel.app

| Contract | Address |
| --- | --- |
| **KairosPool** | [`0xfced18bc0ea5c90b6307f403aa0f21f291b7b7a5`](https://sepolia.etherscan.io/address/0xfced18bc0ea5c90b6307f403aa0f21f291b7b7a5#code) |
| cUSDC wrapper (ERC-7984) | [`0xaf4230b61c3416db65000b7e6a5f8a3e7568304b`](https://sepolia.etherscan.io/address/0xaf4230b61c3416db65000b7e6a5f8a3e7568304b#code) |
| cWETH wrapper (ERC-7984) | [`0x17b1febaa37a45331f9615d28cd7e489fd4f9125`](https://sepolia.etherscan.io/address/0x17b1febaa37a45331f9615d28cd7e489fd4f9125#code) |
| tUSDC (faucet token) | [`0xb388c8cdf22bd89f0110620a0b557baa5d9d6ef1`](https://sepolia.etherscan.io/address/0xb388c8cdf22bd89f0110620a0b557baa5d9d6ef1#code) |
| tWETH (faucet token) | [`0x3003e7d75477c4f6836ec117f6e9c1202e09da84`](https://sepolia.etherscan.io/address/0x3003e7d75477c4f6836ec117f6e9c1202e09da84#code) |
| Uniswap V3 pool (unmodified) | [`0xd35EA7f04Afc631A5A664Ab2dc9420329615D124`](https://sepolia.etherscan.io/address/0xd35EA7f04Afc631A5A664Ab2dc9420329615D124) |

Chain: Ethereum Sepolia (11155111) · NoxCompute: `0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF`
All contracts verified on Etherscan, Blockscout and Sourcify.

### Try it in about three minutes

1. Open [the app](https://kairos-layerr.vercel.app) with any browser wallet on Sepolia
2. **Get started** — mint test tokens, wrap them, authorise the pool (3 transactions)
3. **Place an order** — watch the amount get encrypted before it leaves the page
4. Do the same from a second wallet on the opposite side (the privacy floor is 2/side)
5. **Settlement desk** — run the crank yourself, or wait for the keeper
6. **Proof of no leakage** — audit the whole history and see the verdict for yourself

---

## Settlement is an asynchronous state machine

The enclave cannot answer within the transaction that asks, so settlement is a
sequence of independent, permissionless, idempotent, state-guarded steps:

```
Open ──seal──> Sealed ──reveal──> Revealed ──initiate──> UnwrapPending ──finalize──> Distributable
   window          totals            residual              release +                claims open
   closes          decrypted         computed              swap + re-shield          (pull-based)
                                                                │
                          any step past its timeout ──> Cancelled ──> full refunds
```

Two design rules follow, and both are load-bearing:

- **Every transition is permissionless.** No privileged operator exists. The keeper is
  a convenience, not an authority.
- **No user funds can be stranded.** Every state has a timeout that leads to refunds,
  so a stalled enclave or an absent keeper costs latency, never principal.

Claims are **pull-based** — the contract never loops encrypted operations over an
unbounded array of users.

---

## Repository

```
contracts/     Hardhat 3 + @iexec-nox/nox-hardhat-plugin
               KairosPool, ERC-7984 wrappers, faucet tokens, integration tests, deploy scripts
frontend/      Next.js + viem + @iexec-nox/handle — 15 pages, encryption happens here
keeper/        permissionless settlement bot; also runs as a GitHub Action
feedback.md    24 findings on the iExec Nox toolchain, logged as they were hit
AGENTS.md      engineering spec: architecture, state machine, every edge case
DEPLOYMENT.md  deploy it yourself — one secret required
```

### Run it locally

```bash
# Contracts — the Nox plugin boots a real TEE stack in Docker, so encrypted
# flows are exercised for real rather than mocked. Needs Node 22+ and Docker.
cd contracts && npm install && npm test

# Frontend — no environment variables required at all
cd frontend && npm install && npm run dev

# Keeper — one burner key holding only gas
cd keeper && npm install && npm run dry
```

Full end-to-end rehearsal against live Sepolia: `node contracts/scripts/e2e-sepolia.mjs`

---

## What is worth looking at

**[`/proof`](https://kairos-layerr.vercel.app/proof) — the zero-leakage audit.**
Rather than asking anyone to trust the privacy claim, the app replays every event the
protocol has ever emitted and every order transaction ever sent, classifies each field
as sealed / disclosed / leaked, and hunts for a plaintext amount attributable to an
individual. The audit is recomputed from chain history every time the page loads, and
the standing verdict is **0 leaks**. Anyone can re-run it against the live deployment.

**[`/analytics`](https://kairos-layerr.vercel.app/analytics) — what netting is worth.**
Reconstructs what the same orders would have cost executed individually against the
same pool: fees avoided, price impact avoided, notional never exposed to a searcher.
One-sided epochs honestly report zero saved, because they netted nothing.

**[`/auditor`](https://kairos-layerr.vercel.app/auditor) — compliance without publicity.**
A scoped, forward-only auditor can decrypt orders in the epochs they were appointed
for, and nothing else, ever. A venue no supervisor can inspect is not one a regulated
institution can use.

**[`/security`](https://kairos-layerr.vercel.app/security) — the bugs we found in
ourselves.** Four independent adversarial reviews, including two findings that would
have broken the deployment outright, published in full. A privacy project that hides
its failures is asking for the wrong kind of trust.

---

## Honest limitations

Stated here as prominently as the claims, and repeated on the site at `/privacy` and
`/faq`:

- **Direction and participation are public.** Only amounts are hidden. Observers see
  that you traded and which way, not how much.
- **Trust is hardware, not mathematics.** Confidentiality rests on Intel TDX
  attestation and iExec's key management. If the TEE is broken, the amounts are
  readable. This is a different assumption from a ZK system, and a weaker one.
- **Participant counts are an upper bound.** An order exceeding your balance moves
  zero but still registers, so a sybil can inflate the anonymity floor. The floor
  raises the cost of deanonymisation; it does not make it impossible.
- **The heavy side absorbs the residual's cost.** Fee and price impact fall on the
  side that overflowed. A production version would blend one clearing price across
  both sides.
- **Netting requires counterparties.** A one-sided batch degrades to an ordinary
  aggregated swap — still private in amount, but nothing is crossed. Epochs #2 and #7
  show exactly this, and the analytics page reports them as 0% shielded.
- **Testnet software.** Carefully reviewed and adversarially tested, but not
  professionally audited. Do not put real money in it.

---

## Built during the hackathon

Every line of Solidity, TypeScript and infrastructure in this repository was written
during the WTF Hackathon: `KairosPool`, the ERC-7984 wrappers and faucet tokens, the
15-page frontend, the keeper, the integration tests, the deploy scripts and the
verification.

**Nothing was ported from a prior project.** The only external code is used unmodified
as a dependency:

| Dependency | Role |
| --- | --- |
| `@iexec-nox/nox-protocol-contracts`, `@iexec-nox/nox-confidential-contracts` | Nox SDK, ERC-7984, `ERC20ToERC7984Wrapper` |
| `@iexec-nox/handle` | Browser-side encryption |
| Uniswap V3 | The public venue the residual settles against — **unmodified**, composed with, never forked |
| OpenZeppelin | Standard token and access primitives |

We deploy and seed our own tUSDC/tWETH V3 pool because Sepolia has no canonical one,
and we swap directly against the pool's `swap` + callback since Sepolia has no
SwapRouter deployment.

---

## Feedback for iExec

[`feedback.md`](feedback.md) is a running log of **24 findings** on the Nox toolchain,
written as they were encountered rather than reconstructed at the end. It includes
reproducible bugs with suggested fixes, among them:

- `getAddress` returning a checksummed string where a comparison expected lowercase
- `@iexec-nox/handle` importing `ethers` unconditionally even on the viem path, which
  breaks plain Node consumers such as a keeper bot
- ACL transience being the single largest source of lost development time, and what
  documentation would have prevented it
- Divergences between the local Docker TEE stack and live Sepolia behaviour

---

## Demo

<!-- Replace with the recorded walkthrough before submission -->
**Video:** _to be added_

The walkthrough shows two wallets placing opposite orders, the amounts encrypted in
the browser, Etherscan carrying only aggregates and the residual swap, a user
decrypting their own payout, a foreign decryption attempt failing, and the netting
moment where matched volume never reaches the chain.

---

<p align="center"><sub>Ethereum Sepolia · chain 11155111 · built on iExec Nox ·
testnet software, not audited for production use</sub></p>
