# CLAUDE.md — Kairos Layer (iExec WTF Hackathon)

**Read `AGENTS.md` first — it is the canonical spec** (architecture, epoch state machine, all edge cases, pinned addresses, deliverables checklist). This file only holds the rules you must never violate and the working setup.

## Project in one breath
Kairos Layer = dark pool on Sepolia. Encrypted swap orders (iExec Nox `euint256` handles) → two-sided epoch netting at a uniform price → only the net residual swapped on unmodified Uniswap V3 → encrypted pro-rata pull-claims. Main contract: `KairosPool`. Monorepo: `contracts/` (**Hardhat 3** + `@iexec-nox/nox-hardhat-plugin`), `frontend/` (Next.js + viem + `@iexec-nox/handle`), `keeper/` (Node crank bot).

## Hard rules (violating any of these breaks the product or the hackathon)
1. **Encrypt only in the browser.** Plaintext amounts must never appear in calldata, events, storage, or logs. Contract ingests via `Nox.fromExternal(handle, proof)`.
2. **`allowPublicDecryption` only on epoch aggregate handles.** Never on per-user handles. Grep before every merge.
3. **After EVERY Nox op that yields a handle, grant ACL** (`Nox.allowThis()` + `Nox.allow(user)` where the user must read). ACL is transient per-tx by default; forgetting = bricked handle = #1 bug class. Test handle usability in a *separate* tx.
4. **Never modify Uniswap or any underlying protocol** — compose only. No mock data anywhere in the deployed app.
5. **Settlement is an async multi-tx state machine** (see AGENTS.md §4.1): every transition permissionless, idempotent, state-guarded, with timeout → cancel → refund. No user funds may ever be stranded.
6. **Pull-based claims only** — never loop encrypted ops over unbounded user arrays.
7. **No plaintext-observable branching on encrypted comparisons** (use `select`/`safeSub` semantics — silent-zero, not revert).
8. **Secrets in `.env` only** (gitignored). Burner testnet keys. Never log or commit keys.
9. Target chain is **ETH Sepolia (11155111)** — hackathon requirement. NoxCompute there: `0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF`.
10. Maintain `feedback.md` as a **running log** of iExec/Nox DX friction as it's encountered — it is a judged deliverable, don't backfill at the end.

## Stack quick-reference
- Contracts: **Hardhat 3** + `@iexec-nox/nox-hardhat-plugin` (official path — Foundry was considered and rejected: no Nox support, guide "Coming Soon"). Needs Node 22+, **Docker running**; plugin boots a local Nox TEE stack + `nox` test helper, so encrypted flows are tested for real, locally. Config: plugin registered + default network `{ type: 'edr-simulated', chainType: 'op' }`; viem integration only (never mix with ethers).
- Node 22+, pnpm workspaces monorepo; tests in TypeScript + viem.
- Solidity 0.8.28; deps `@iexec-nox/nox-protocol-contracts` + `@iexec-nox/nox-confidential-contracts` (ERC7984, ERC20ToERC7984Wrapper).
- JS: viem everywhere (not ethers). SDK `@iexec-nox/handle` encrypts only `bool,uint16,uint256,int16,int256` → design around `uint256`.
- Uniswap Sepolia: **no SwapRouter** — swap **directly against the V3 pool** (`swap` + callback); addresses pinned in AGENTS.md §3. We deploy & seed our own tUSDC/WETH9 pool.
- Docs: https://docs.noxprotocol.io · status: https://status.noxprotocol.io (check before demos).

## Working agreements for Claude
- Edge cases live in AGENTS.md §5 — treat that list as the review checklist for every contract PR; add newly discovered cases there in the same change.
- Async TEE flows (reveal / unwrap finalize / decrypt) need pending-state UI + polling + keeper retries with backoff. Never assume same-tx results.
- Deploy scripts must be idempotent (pool creation, seeding, verification) and write `deployments.json`.
- Before recording/submitting: run the full E2E rehearsal on Sepolia; verify contracts on Etherscan; check the deliverables checklist in AGENTS.md §7.
- First action of the project (before code): validate the idea in the iExec Discord WTF channel to rule out collision with prior VIBE projects.
