# Kairos Layer

**A dark pool for Ethereum.** Submit a swap order and nobody sees the size — not the
public chain, not other traders, not the operator. Orders in opposite directions are
matched against each other inside a trusted enclave, and only the unmatched residual
is swapped on real Uniswap V3.

Built on [iExec Nox](https://docs.noxprotocol.io) for the WTF Hackathon. Live on
Ethereum Sepolia, with no mock data anywhere.

```
 encrypted orders          netted in the enclave         only the residual
   (amounts hidden)   →     at one clearing price    →    reaches Uniswap
```

In a real settled batch: **1,500 tUSDC of buy orders met 0.3 tWETH of sell orders.
609 tUSDC crossed internally and never touched the public chain — 40.6% of the
volume was invisible.** Only the 891 tUSDC residual was swapped.

---

## Why this is not just "encrypted swaps"

Encryption alone is not privacy. If your order settled instantly and alone, the
resulting swap *would be* your order, plainly visible. Kairos combines three
mechanisms, and the third is the one that matters:

1. **Encryption** — amounts are Nox handles; the chain stores pointers, arithmetic
   happens in Intel TDX.
2. **Aggregation** — only per-side totals are ever decrypted, and only once enough
   participants have joined that a total hides them.
3. **Netting** — matched volume is not hidden, it is *absent*. There is no
   transaction to analyse because none was made.

And it composes rather than forks: the residual is an ordinary swap against the
canonical Uniswap V3 pool, so liquidity is never fragmented and no Uniswap code was
modified.

---

## Live on Sepolia

| Contract | Address |
| --- | --- |
| **KairosPool** | [`0xfced18bc0ea5c90b6307f403aa0f21f291b7b7a5`](https://sepolia.etherscan.io/address/0xfced18bc0ea5c90b6307f403aa0f21f291b7b7a5#code) |
| cUSDC wrapper | [`0xaf4230b61c3416db65000b7e6a5f8a3e7568304b`](https://sepolia.etherscan.io/address/0xaf4230b61c3416db65000b7e6a5f8a3e7568304b#code) |
| cWETH wrapper | [`0x17b1febaa37a45331f9615d28cd7e489fd4f9125`](https://sepolia.etherscan.io/address/0x17b1febaa37a45331f9615d28cd7e489fd4f9125#code) |
| tUSDC (faucet) | [`0xb388c8cdf22bd89f0110620a0b557baa5d9d6ef1`](https://sepolia.etherscan.io/address/0xb388c8cdf22bd89f0110620a0b557baa5d9d6ef1#code) |
| tWETH (faucet) | [`0x3003e7d75477c4f6836ec117f6e9c1202e09da84`](https://sepolia.etherscan.io/address/0x3003e7d75477c4f6836ec117f6e9c1202e09da84#code) |
| Uniswap V3 pool | [`0xd35EA7f04Afc631A5A664Ab2dc9420329615D124`](https://sepolia.etherscan.io/address/0xd35EA7f04Afc631A5A664Ab2dc9420329615D124) |

All verified on Etherscan, Blockscout and Sourcify.

---

## Repository

```
contracts/   Hardhat 3 + @iexec-nox/nox-hardhat-plugin — KairosPool, wrappers, tests, deploy
frontend/    Next.js — 15 pages, talks straight to the chain and the enclave
keeper/      permissionless settlement bot (also runs as a GitHub Action)
feedback.md  24 findings on the iExec Nox toolchain, logged as they happened
AGENTS.md    the engineering spec: architecture, state machine, every edge case
DEPLOYMENT.md how to deploy it yourself — one secret required
```

## Run it

```bash
# contracts — tests run against a real Nox enclave in Docker, not mocks
cd contracts && npm install && npm test

# frontend — no environment variables needed
cd frontend && npm install && npm run dev

# keeper — needs one burner key with gas
cd keeper && npm install && npm run dry
```

Full end-to-end run against live Sepolia: `node contracts/scripts/e2e-sepolia.mjs`.

---

## What is worth looking at

**`/proof` — the zero-leakage audit.** Rather than asking you to trust the privacy
claim, the app replays every event the protocol has emitted and every order
transaction ever sent, classifies each field, and hunts for a plaintext amount
attributable to a user. Current verdict on live data: **34 events, 12 of them
per-user, 0 leaks.**

**`/analytics` — what netting is worth.** Reconstructs what the same orders would
have cost executed individually on the same pool: fees avoided, price impact
avoided, notional never exposed to a searcher.

**`/auditor` — compliance without publicity.** A scoped, forward-only auditor may
decrypt orders in the epochs they were appointed for, and nothing else, ever. A venue
no supervisor can inspect is not deployable by a regulated institution.

**`/security` — the bugs we found in ourselves.** Four independent adversarial
reviews, including two findings that would have broken the deployment outright.
Published in full, because a privacy project that hides its failures is asking for
the wrong kind of trust.

---

## Honest limitations

- Participation and trade **direction** are public; only amounts are hidden.
- Confidentiality rests on Intel TDX attestation and iExec's key management —
  hardware trust, not cryptographic trust.
- Participant counts are an **upper bound**: an order exceeding your balance moves
  zero but still registers, so a sybil can pad the anonymity floor.
- The heavy side of a batch absorbs the residual's fee and impact; a production
  version would blend one clearing price across both sides.
- Testnet software. Reviewed carefully, but not professionally audited.

These are stated on the site as prominently as the claims — see `/privacy` and
`/faq`.

---

## Built during the hackathon

Everything in this repository was written for the WTF Hackathon: the contracts, the
frontend, the keeper, the tests and the deployment. The only external code is
`@iexec-nox/*` (the Nox protocol and SDK), OpenZeppelin, and Uniswap V3 — all used
unmodified, as dependencies.
