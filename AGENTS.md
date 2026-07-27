# Kairos Layer — Confidential Dark Pool on Uniswap (iExec Nox)

> Canonical engineering spec & agent guide. `CLAUDE.md` points here. Keep this file updated when architecture or decisions change.

## 1. What we are building

**Kairos Layer** is a dark pool for Ethereum: users submit swap orders whose **amounts are encrypted end-to-end** (iExec Nox handles). Orders in opposite directions are **netted against each other inside an epoch at a uniform clearing price**; only the **unmatched residual** is swapped through the real, unmodified **Uniswap V3** on Sepolia. Matched volume never appears on-chain, individual order sizes never appear anywhere — only epoch aggregates are ever publicly decrypted.

**One-liner:** *"Encrypted orders matched in a TEE; only the net residual reaches Uniswap — better prices, zero MEV signal, selective auditability."*

**Layered scope (build in this order — each layer is independently submittable):**
1. **L1 Batcher** — one-direction encrypted batch → aggregate decrypt → single Uniswap swap → encrypted pro-rata distribution.
2. **L2 Netting (headline)** — two-sided epochs (USDC→WETH and WETH→USDC), internal cross at uniform price, only residual hits Uniswap.
3. **L3 Product polish** — recurring encrypted orders (private DCA) + auditor read-access via `addViewer` ("regulatable dark pool").

**Hackathon context:** iExec WTF Hackathon Summer Edition. Judged on: creativity (⭐⭐⭐), works end-to-end **without mock data** (⭐⭐⭐), deployed on **ETH Sepolia** (⭐⭐), `feedback.md` in repo (⭐⭐), ≤4-min video (⭐⭐), Nox leverage (⭐), UX (⭐). Underlying protocols (Uniswap) must NOT be modified. Reusing prior VIBE-hackathon projects = disqualification. Submission = X post tagging @iEx_ec with demo video + public repo link.

## 2. Architecture

```
Browser (Next.js + @iexec-nox/handle SDK)
  │  encryptInput(amount) → {handle, proof}     ← plaintext NEVER leaves browser
  ▼
KairosPool.sol (ours, Sepolia) ── ERC7984 cUSDC / cWETH (ERC20ToERC7984Wrapper, ours)
  │  epoch state machine, encrypted sums (Nox.add), ACL mgmt
  │  aggregate-only allowPublicDecryption
  ▼
Keeper bot (ours, Node/viem) — permissionless crank: seal → reveal → swap → distribute
  ▼
Uniswap V3 (canonical, unmodified, Sepolia)   +   Nox protocol stack (iExec-run TEE infra)
```

Components (planned monorepo layout):
- `contracts/` — **Hardhat 3** project (+ `@iexec-nox/nox-hardhat-plugin`): `KairosPool.sol`, wrapper deployments, TS deploy/verify scripts, tests against the local Nox Docker stack.
- `frontend/` — Next.js + wagmi/viem + `@iexec-nox/handle`. Wallet connect, wrap/unwrap, order submit, own-balance decrypt, epoch dashboard, settle button.
- `keeper/` — small Node service (viem) that cranks epoch settlement; every action it does must also be doable manually from the UI (demo resilience).
- `feedback.md`, `README.md`, `docs/`, `demo/` (video script + seed scripts).

## 3. Stack & pinned facts (verified July 2026 — re-verify on setup)

| Thing | Value |
|---|---|
| Chain (required) | Ethereum Sepolia, chainId `11155111` |
| NoxCompute (Sepolia) | `0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF` |
| NoxCompute (local 31337) | `0x8289125DF2ae6d6c2a18FDFf63639896791276e7` — resolved by `Nox.sol` on the plugin's local Docker stack |
| Solidity | `0.8.28` (Nox confidential contracts require ≥0.8.27) |
| Contracts deps | `@iexec-nox/nox-protocol-contracts` (Nox.sol lib), `@iexec-nox/nox-confidential-contracts` (ERC7984, ERC20ToERC7984Wrapper) |
| JS SDK | `@iexec-nox/handle` — `encryptInput`, `decrypt`, `publicDecrypt`, `viewACL`; ethers & viem adapters; **we use viem** everywhere |
| SDK encryptable types | ONLY `bool, uint16, uint256, int16, int256` — design around `uint256` |
| Tooling | **Hardhat 3** + `@iexec-nox/nox-hardhat-plugin` — the officially supported path (all Nox reference repos are Hardhat 3). Needs Node 22+, pnpm, **Docker running**; the plugin boots a local Nox TEE stack automatically and exposes a `nox` test helper (encrypt/decrypt in tests, no manual setup). Config: register the plugin + default network `{ type: 'edr-simulated', chainType: 'op' }`; pick ONE integration (we use **viem**, not ethers). First test run downloads Docker images (slow once, cached after). Decision note: Foundry was considered and rejected — its official Nox guide is "Coming Soon", there's no local TEE stack for it, and mocking NoxCompute can't validate real encrypted flows. |
| Uniswap V3 Sepolia | Factory `0x0227628f3F023bb0B980b67D528571c95c6DaC1c`, NPM `0x1238536071E1c677A632429e3655c799b22cDA52`, QuoterV2 `0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3`, WETH9 `0xfff9976782d46cc05630d1f6ebab18b2324d6b14` |
| ⚠️ Uniswap routing | `SwapRouter`/`SwapRouter02` is **NOT officially deployed on Sepolia**. Official entrypoint: **UniversalRouter** `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b`. **Decision:** prefer calling the **pool directly** (`IUniswapV3Pool.swap` + `uniswapV3SwapCallback` in VeilPool) — zero router dependency, fewest surprises. Fall back to UniversalRouter only if needed. |
| Liquidity | We deploy our own `tUSDC` (6 dec, mintable faucet) and seed our own `tUSDC/WETH9` 0.3% pool via NPM. Real Uniswap contracts + testnet tokens = allowed; "no mock data" means no faked balances/flows, not mainnet assets. |
| Nox status page | https://status.noxprotocol.io — check before demo recording |
| Docs | https://docs.noxprotocol.io (docs.iex.ec redirects there) |

## 4. Core flows

### 4.1 Epoch state machine (the heart of the system — settlement is ASYNC, multi-tx)

```
OPEN ──seal()──▶ SEALED ──reveal(proofs)──▶ REVEALED ──initiateSettlement()──┐
  │                 │                          │                             │
  │                 └──────────┬───────────────┘              residual == 0 ─┤
  │                     cancelEpoch()                                        ▼
  │                            ▼                              UNWRAP_PENDING │
  └─emergencyCancelOpenEpoch()─▶ CANCELLED ◀──recoverEpoch()────┤            │
                                    │                           │ finalizeSettlement(proof,minOut)
                                    │                           │ abandonEpoch()
                          claimRefund(user)*                    ▼            ▼
                                                            DISTRIBUTABLE ◀──┘
                                                            claim(user)*
```
As implemented (see `contracts/README.md` for the hatch table). Key properties:
every transition is permissionless and state-guarded; **no state can strand funds**;
`abandonEpoch` refuses to run when the residual is still recoverable or when the
write-off would zero a funded side; each epoch **snapshots** its timeouts, slippage
bound, privacy floor and auditor at open time so owner changes never apply
retroactively.

Rules:
- Every transition is **permissionless, idempotent, and guarded by state checks** (`require(state == X)`). The keeper is a convenience, never a trust assumption.
- **Timeouts:** if `REVEAL_PENDING` exceeds `revealTimeout` (e.g. 1h) or the residual swap keeps failing, anyone can `cancelEpoch()` → per-user refunds. No user funds may ever be stuck on a dead epoch.
- A new epoch OPENs immediately when the previous one seals (epochs are pipelined; settlement of epoch N runs concurrently with order intake for N+1).
- Epoch duration: time-based (e.g. 10 min for demo, configurable) AND seals early only via explicit `seal()` after `minEpochDuration`.

### 4.2 User flows
1. **Wrap:** approve tUSDC → `wrapper.wrap(amount)` → cUSDC (encrypted balance). Wrap amounts are public by nature (documented, acceptable — privacy starts inside the pool; recommend wrapping more than you trade).
2. **Submit order:** frontend `encryptInput(amount, 'uint256', KAIROS_POOL_ADDR)` → `submitOrder(direction, extHandle, proof)`. Contract: `Nox.fromExternal` → pulls cToken via ERC-7984 **operator** transfer → `buyTotal = Nox.add(buyTotal, amt)` (or sellTotal) → **`Nox.allowThis(...)` on every new/derived handle** → stores per-user encrypted order amount (also `allowThis` + `Nox.allow(user)` so the user can always decrypt their own order).
3. **Cancel (only while OPEN):** confidential transfer back; subtract from encrypted total (`Nox.sub`); decrement order count.
4. **Settle (keeper or UI button):** seal → `allowPublicDecryption` on the **two aggregate handles only** → SDK `publicDecrypt` → post plaintext totals + proof on-chain → netting math (plaintext): `matched = min(buyUSDC_valued, sellUSDC_valued)` at clearing price; residual swapped **direct against the V3 pool** with `minOut` from QuoterV2 quote ± slippage bound and a deadline.
5. **Distribution — PULL, not push:** `claim(epochId)` computes `userOut = Nox.div(Nox.mul(userIn, totalOutPlain), totalInPlain)` in-TEE, credits cToken out, grants ACL to user. O(1) encrypted ops per claim; no unbounded loops in settlement. Users can also `claimMany` lazily; unclaimed funds persist indefinitely.
6. **Withdraw:** two-step unwrap (`unwrap()` → request id → TEE decrypts → `finalizeUnwrap(amount, proof)`). UI must show a "pending unwrap" state and poll.
7. **Own-balance decrypt:** `handleClient.decrypt(balanceHandle)` — works only for the owner / granted viewers; the UI's "decrypt" on someone else's balance MUST fail (this is a demo moment).

### 4.3 Clearing price (L2)
Uniform price for internal crossing = the **effective execution price of the residual swap** (out/in of the actual Uniswap fill). When residual is 0 (perfect cross), use QuoterV2 midpoint quote posted by the settler, sanity-bounded on-chain vs. pool `slot0` TWAP-ish check. Document this trust bound honestly in README; tighten later with an on-chain TWAP oracle.

## 5. Edge cases & invariants — CHECK EVERY ONE BEFORE MERGING CONTRACT CODE

### Post-audit invariants added to the implementation (do not regress)
- **A1 — k-anonymity floor:** `seal()` never publicly decrypts an aggregate for a side
  with fewer than `minOrders` participants; the epoch cancels for refunds instead. A
  1-participant "aggregate" IS that user's order.
- **A2 — per-epoch escrow:** every pending residual is tracked in `escrowedIn[token]`;
  consumption paths verify the balance covers ALL outstanding escrows, and `sweepDust`
  can only move `balance − escrowed`. This replaced a global settlement lock that was
  found to enable a protocol-wide DoS — do not reintroduce serialization.
- **A3 — TWAP-validated pricing:** the internal cross and the residual swap both
  require spot within `maxTickDeviation` of the `twapWindow` TWAP. A same-transaction
  spot read is NOT a slippage guard (it moves with the attacker).
- **A4 — caller `minOut`:** `finalizeSettlement` takes an off-chain quote that may only
  tighten the on-chain floor. A hostile cranker can abort, never underfill.
- **A5 — no destructive write-off:** `abandonEpoch` reverts if the residual is still
  recoverable, or if the write-off would leave a funded side with a zero payout;
  `claim` refuses to consume a funded position for a zero payout.
- **A6 — parameter snapshots:** epochs capture timeouts, slippage, privacy floor and
  auditor at open time; owner changes never apply retroactively (this also prevents a
  new auditor from being granted viewer access to historic orders).
- **A7 — deployability:** the optimizer MUST stay enabled (the contract exceeds the
  EIP-170 limit without it; local test chains hide this), and `evmVersion` stays pinned.

### Privacy invariants (non-negotiable)
- **P1:** Plaintext order amounts must never appear in calldata, events, storage, or logs. Encryption happens **only in the browser** via `encryptInput`. Never implement "Pattern B" (encrypting on-chain from a plaintext arg) anywhere, including tests of the deployed contracts.
- **P2:** `allowPublicDecryption` may ONLY ever be called on epoch **aggregate** handles. Grep for it in review; any other call site is a critical bug.
- **P3:** Per-user handles get ACL: `allowThis` (contract can reuse) + `allow(user)` (owner can decrypt). Auditor gets `addViewer` **only** on handles explicitly disclosed via the auditor flow, and only to the configured auditor address.
- **P4:** No function may leak amounts via revert/branching: use `Nox.safeSub`/`select` semantics — insufficient-balance transfers silently move 0 by ERC-7984 design; **never** add a plaintext-observable branch on an encrypted comparison.

### Nox-specific gotchas
- **ACL is transient by default** — permissions die at end of tx. EVERY operation producing a handle (`add`, `sub`, `mul`, `div`, `fromExternal`, `select`, ...) must be followed by `Nox.allowThis()` (+ `Nox.allow(user)` where the user needs read). Forgetting this bricks the handle next tx. This is the #1 bug class — make it a code-review checklist item and test every handle's next-tx usability.
- **Handle proofs are bound to the target contract address** (`encryptInput(..., contractAddr)`) — proofs can't be replayed across contracts, and every fresh deployment needs freshly encrypted inputs (test fixtures must re-encrypt, never hardcode handles).
- **All TEE flows are async** (reveal, unwrap finalize, decrypt): every UI action needs pending/optimistic states + polling; keeper needs retry with exponential backoff and a max-attempts → surface-to-UI path.
- **safeSub silent-zero:** a user "ordering" more than their cUSDC balance results in a 0-amount order that still increments the order count. Consequence: order count is an upper bound on real participants (relevant to min-batch-size k-anonymity — document; can't be fixed without leaking balances, it's inherent to the model).
- **Encrypted ops cost gas + TEE latency**: minimize handle operations per tx; never loop encrypted ops over unbounded arrays (hence pull-claims).
- Wrapper needs the pool as **ERC-7984 operator** with an `untilTimestamp`: frontend must set a sane expiry (e.g. now + 24h) and detect/renew expired operators, else transfers silently move 0.
- Nox testnet infra can be down — keeper backs off; check status page pre-demo; record demo with a fallback local screen-capture of a previous successful run *only as B-roll*, the submitted demo must be live-on-Sepolia.

### Epoch/settlement edge cases
- **Batch of 1 (or all-one-sided small batch):** no anonymity. Enforce `minOrders` (e.g. 3) to settle-with-swap; below threshold → epoch auto-extends once, then settles anyway with a UI warning shown at order time ("low-privacy epoch"). Honest docs > silent failure.
- **Empty epoch:** seal → immediately SETTLED, no reveal, no swap.
- **Perfect cross (residual = 0):** skip Uniswap entirely (this is a headline demo moment — "nothing touched the chain").
- **One-sided epoch:** netting degenerates to L1 batcher; full total swapped.
- **totalIn = 0 after reveal** (all orders were silent-zero): mark SETTLED, claims yield 0, no division by zero — guard every division with `require(totalInPlain > 0)` or short-circuit.
- **Rounding dust** from pro-rata integer division stays in the contract; expose `sweepDust(token, to)` owner-only, documented.
- **Decimals:** tUSDC = 6, WETH = 18. All ratios computed in raw base units with mul-before-div ordering; wrapper is 1:1 in base units. Write explicit unit tests for mixed-decimal pro-rata.
- **Slippage/swap failure:** residual swap carries `minOut` (QuoterV2 quote − maxSlippageBps) + deadline; on revert, retry up to N times (price may move), then `cancelEpoch` → refunds. Never leave epoch wedged.
- **Reveal never arrives:** `revealTimeout` → `cancelEpoch` → refunds of the *encrypted recorded* amounts (contract still holds the cTokens; refund is a confidential transfer of the stored order handle — this is why per-user order handles must retain `allowThis`).
- **Crank griefing/front-running:** all transitions idempotent & state-guarded; a raced duplicate call reverts harmlessly. `swapResidual` params (quote, minOut) validated on-chain against bounds so a malicious cranker can't set minOut=0.
- **User in both directions same epoch:** allowed; nets naturally; claims computed per-direction.
- **Cancel after seal:** forbidden (`require(state == OPEN)`).
- **Multiple orders per user per epoch:** allowed → `Nox.add` onto their existing order handle (re-grant ACL after).
- **Claim before DISTRIBUTABLE / double-claim:** state-guarded + per-user claimed flag per epoch.
- **Uniswap pool exists & funded:** deploy script must create+seed the pool idempotently and assert liquidity ≥ demo threshold; QuoterV2 quote failure (no pool) must produce a clear error, not a wedged epoch.

### Ops/security hygiene
- **Secrets:** `.env` (gitignored) only; `PRIVATE_KEY`, `RPC_URL`, `ETHERSCAN_API_KEY`. NEVER commit or log. Deployer/keeper keys are burner testnet keys.
- Contracts: no `tx.origin`, reentrancy guards on state transitions touching external calls (swap, wrapper), CEI ordering, custom errors over strings, events for every state transition (the frontend is event-driven).
- Upgradability: **none** — immutable deployments, redeploy on change (hackathon-appropriate; note in README).
- Etherscan-verify every deployed contract (judges will look).
- Pin all dependency versions exactly; commit `pnpm-lock.yaml`.

## 6. Testing strategy (Hardhat 3 + nox-hardhat-plugin)

- **Local integration (primary tier):** `pnpm hardhat test` with the plugin's local Nox Docker stack — **real encrypted ops, locally**, via the `nox` test helper. Full coverage of: the epoch state machine (every transition, timeout, cancel/refund path), ACL persistence (assert every stored handle is still usable in a **separate, later tx** — catches the transient-ACL footgun), silent-zero orders, mixed 6/18-decimal pro-rata math, rounding dust, double-claim/cancel-after-seal/division-by-zero guards, multi-order-per-user, both-directions-per-user, and event emission per transition. Tests are TypeScript + viem (same language as frontend/keeper).
- **Uniswap path:** the direct-pool `swap` + callback and QuoterV2 `minOut` logic tested locally against a locally-deployed Uniswap V3 factory/pool fixture (deploy from canonical artifacts in the test setup — Uniswap won't exist on the plugin's simulated network), then re-validated on real Sepolia before the demo.
- **E2E (TypeScript + viem + `@iexec-nox/handle`, real Sepolia):** the **source of truth** for "works end-to-end without mock data". Scripted full flow — wrap → submit encrypted orders from 2+ wallets → seal → reveal (real TEE publicDecrypt) → swap on real Uniswap → claim → owner-decrypt succeeds / foreign-decrypt fails → 2-step unwrap. Run after every deployment and before every demo; it doubles as the demo-video rehearsal script, timed to fit 4 min with narration.
- Every local-stack-vs-Sepolia behavioral divergence gets logged in `feedback.md` (judged deliverable — keep it running, don't backfill).

## 7. Hackathon deliverables checklist
- [ ] Contracts deployed + verified on Sepolia (record addresses in `README.md` + `deployments.json`)
- [ ] Frontend deployed (Vercel), working against Sepolia, zero mock data
- [ ] Keeper running (or UI-manual settle demonstrated)
- [ ] `README.md`: setup, architecture diagram, addresses, trust model & known limitations (honest!)
- [ ] `feedback.md`: concrete iExec/Nox DX feedback collected **throughout development** (keep a running log — judged ⭐⭐)
- [ ] `docs/`: what existed before vs. built during hackathon (originality statement)
- [ ] ≤4-min demo video: 2 wallets, hidden amounts, Etherscan shows only aggregate/residual, own-decrypt works, foreign-decrypt fails, perfect-cross moment if stageable
- [ ] X post tagging @iEx_ec: description + video + repo link
- [ ] Idea validated with organizers on Discord (anti-disqualification) — do this FIRST

## 8. Conventions
- TypeScript strict everywhere; viem (not ethers) in ALL packages including contract tests; pnpm workspaces monorepo (`contracts/`, `frontend/`, `keeper/`); solc version pinned in Hardhat config.
- Solidity: NatSpec on external functions, `error Kairos_*` custom errors, events past-tense (`EpochSealed`), immutables where possible; prettier-plugin-solidity for formatting.
- Deploys: idempotent Hardhat scripts (safe to re-run: skip existing pool, top-up-only seeding) + Etherscan verification; every deployment recorded in `deployments.json` (consumed by frontend & keeper — single source of addresses).
- Commits: conventional (`feat(contracts): ...`), small and buildable.
- Naming: project = **Kairos Layer**; main contract `KairosPool`; cUSDC/cWETH for wrapped confidential tokens.
- Every architectural decision that deviates from this file → update this file in the same PR.
