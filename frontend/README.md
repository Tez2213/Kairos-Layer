# Kairos Layer — Frontend

Next.js app for the confidential dark pool. Talks directly to the deployed Sepolia
contracts and to the iExec Nox enclave; there is no backend and no mock data.

## Run

```bash
npm install
npm run dev     # http://localhost:3000
```

**No environment variables are required.** The app falls back to public Sepolia
endpoints and the contract addresses are compiled into `lib/generated.ts`.

## Deploying (Vercel)

Import the repo, set the root directory to `frontend`, and deploy. **Nothing else is
needed.** Reads are batched through Multicall3 — a page refresh costs about four
upstream requests — and spread across several public endpoints with automatic
failover, so the free nodes are comfortable.

The variables below are optional, for heavy traffic or a guaranteed SLA:

| Variable | Where | Notes |
| --- | --- | --- |
| `SEPOLIA_RPC_URL` | server-side (recommended) | Used by the `/api/rpc` proxy. The key never reaches the browser. |
| `NEXT_PUBLIC_SEPOLIA_RPC_URL` | client-side (alternative) | One less hop, but **embedded in the JS bundle** — only use a domain-restricted key. |

Reads use a viem `fallback` transport across your endpoint, the same-origin proxy and
three public nodes, so a single provider failing does not take the app down. The
proxy only forwards read methods; signing always happens in the user's wallet.

See `.env.example`. Everything else — the iExec Nox gateway, KMS and subgraph — is
resolved automatically by `@iexec-nox/handle` from the chain id.

Contract addresses and ABIs live in `lib/generated.ts`, produced from
`contracts/artifacts` and `contracts/deployments.json`. Regenerate after redeploying.

## The twelve pages

| # | Route | Purpose |
| --- | --- | --- |
| 01 | `/` | What the protocol is, live chain state, cumulative privacy figures |
| 02 | `/how-it-works` | The six-step lifecycle, worked through with real numbers |
| 03 | `/privacy` | Exactly what is hidden vs public, plus a live access-control demo |
| 04 | `/architecture` | Layer map, how a value travels, the settlement state machine |
| 05 | `/start` | Faucet → wrap → authorise: the three transactions to get trading |
| 06 | `/trade` | Encrypt an amount client-side and submit it |
| 07 | `/balances` | Decrypt your own confidential balances; claim payouts and refunds |
| 08 | `/epochs` | Every batch, with crossed-vs-routed proportions |
| 09 | `/epochs/[id]` | One batch in full detail, including the raw storage record |
| 10 | `/settle` | Run the permissionless crank yourself, step by step |
| 11 | `/proof` | **Zero-leakage audit** — replays every event and order transaction and proves no per-user amount was ever published |
| 12 | `/analytics` | **Execution analytics** — what netting saved in fees and price impact, versus executing the same orders individually |
| 13 | `/auditor` | **Compliance & disclosure** — scoped, forward-only auditor access for a regulated deployment |
| 14 | `/security` | Audit findings, invariants, liveness guarantees |
| 15 | `/contracts` · `/faq` | Live parameters and addresses; the awkward questions answered |

## Design notes

The palette is semantic rather than decorative: **green means encrypted**, **orange
means public on-chain**. Anything a viewer must not be able to read renders as a
`▓▓▓▓` cipher block instead of a number, so the privacy boundary is visible at a
glance rather than only described in prose.

Data is monospace with tabular figures, prose is sans, page titles use a serif
display face. Diagrams are hand-written inline SVG — no chart library.

## Structure

```
app/              one directory per page
components/ui     panels, stats, badges, buttons, callouts
components/       diagrams — lifecycle strip, netting bar, state machine, stack map
lib/chain         addresses, epoch-state vocabulary, explorer links
lib/hooks         polling reads against the deployed contract
lib/nox           Nox handle client + retry helpers for enclave round-trips
lib/wallet        minimal EIP-1193 connection (one chain, one account)
lib/generated     ABIs + addresses, generated from the contracts build
```
