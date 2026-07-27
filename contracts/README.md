# Kairos Layer — Contracts

Confidential dark pool on iExec Nox, settling residuals on Uniswap V3. See the root
`AGENTS.md` for the full architecture and threat model.

## Live deployment — Ethereum Sepolia (chainId 11155111)

All contracts are verified on Etherscan, Blockscout and Sourcify.

| Contract | Address |
| --- | --- |
| **KairosPool** | [`0xfced18bc0ea5c90b6307f403aa0f21f291b7b7a5`](https://sepolia.etherscan.io/address/0xfced18bc0ea5c90b6307f403aa0f21f291b7b7a5#code) |
| cUSDC (confidential wrapper) | [`0xaf4230b61c3416db65000b7e6a5f8a3e7568304b`](https://sepolia.etherscan.io/address/0xaf4230b61c3416db65000b7e6a5f8a3e7568304b#code) |
| cWETH (confidential wrapper) | [`0x17b1febaa37a45331f9615d28cd7e489fd4f9125`](https://sepolia.etherscan.io/address/0x17b1febaa37a45331f9615d28cd7e489fd4f9125#code) |
| tUSDC (faucet ERC-20, 6 dec) | [`0xb388c8cdf22bd89f0110620a0b557baa5d9d6ef1`](https://sepolia.etherscan.io/address/0xb388c8cdf22bd89f0110620a0b557baa5d9d6ef1#code) |
| tWETH (faucet ERC-20, 18 dec) | [`0x3003e7d75477c4f6836ec117f6e9c1202e09da84`](https://sepolia.etherscan.io/address/0x3003e7d75477c4f6836ec117f6e9c1202e09da84#code) |
| Uniswap V3 pool (0.3%, canonical factory) | [`0xd35EA7f04Afc631A5A664Ab2dc9420329615D124`](https://sepolia.etherscan.io/address/0xd35EA7f04Afc631A5A664Ab2dc9420329615D124) |
| NoxCompute (iExec) | `0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF` |

Live configuration: 10-minute epochs · `minOrders = 2` (per-side privacy floor) ·
3% max slippage · 1h reveal timeout · 15min unwrap timeout · TWAP guard active
(120s window, 200-tick deviation cap). Pool seeded with 200,000 tUSDC / 100 tWETH,
oracle cardinality 10.

Anyone can mint test tokens via `faucet(amount)` on tUSDC/tWETH.

## Contracts

| Contract | Purpose |
| --- | --- |
| `KairosPool.sol` | The dark pool: encrypted orders, epoch state machine, netting, residual swap, pull-claims |
| `tokens/KairosWrappedToken.sol` | Concrete ERC-20 → ERC-7984 wrapper (deployed as cUSDC and cWETH) |
| `tokens/TestUSDC.sol` | 6-decimal faucet quote token (Sepolia) |
| `tokens/TestWETH.sol` | Local-test WETH stand-in (Sepolia uses canonical WETH9) |
| `test/UniswapSeeder.sol` | Mint-callback helper to seed V3 liquidity (test/deploy only) |
| `interfaces/IUniswapV3.sol` | Minimal V3 pool interface (no router on Sepolia — direct pool swaps) |

## Prerequisites

- Node 22+, Docker running (local Nox TEE stack for tests)
- solc 0.8.35 (pulled automatically; `@iexec-nox/nox-protocol-contracts` requires `^0.8.35`)

## Test

```bash
npm test        # boots the local Nox stack (ingestor/runner/gateway/KMS) in Docker
```

All encrypted operations in tests are REAL TEE operations — no mocks. First run
downloads Docker images. Test transactions go through the plugin's `nox.connect()`
connection; anything sent on the default in-process network is invisible to the stack.

## Deploy to Sepolia

Secrets — pick ONE of the two options:

```bash
# Option A (simplest): fill in the gitignored .env file
#   SEPOLIA_RPC_URL=…  SEPOLIA_PRIVATE_KEY=…  ETHERSCAN_API_KEY=…
cp .env.example .env   # then edit .env

# Option B (encrypted keystore, more secure)
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY   # burner key, funded with ~0.3 Sepolia ETH
npx hardhat keystore set ETHERSCAN_API_KEY

npx hardhat run scripts/deploy-sepolia.ts --network sepolia
```

The deployer key must be a **burner wallet** with ~0.3 Sepolia ETH (gas + the 0.2 WETH
liquidity seed).

The script is idempotent (re-run safe): deploys TestUSDC, cUSDC/cWETH wrappers and
KairosPool, creates + initializes + seeds the tUSDC/WETH9 0.3% pool on the canonical
Uniswap V3 factory only if missing, and records every address in `deployments.json`
(the single source of truth consumed by the frontend and keeper).

Verify each contract afterwards:

```bash
npx hardhat verify --network sepolia <address> <constructor args…>
```

## Epoch lifecycle (crank order)

`submitOrder*` → `seal()` → `reveal(proofs)` → `initiateSettlement()` →
`finalizeSettlement(unwrapProof, minOut)` → `claim()`

Decryption proofs come from the Nox SDK (`publicDecrypt`) and are verified on-chain.
Every crank is permissionless. `minOut` comes from an off-chain quote (QuoterV2) and
may only *tighten* the on-chain floor — a hostile cranker can abort a settlement but
never force a worse fill.

Liveness escapes, none of which can strand funds:

| Hatch | When | Outcome |
| --- | --- | --- |
| `emergencyCancelOpenEpoch` | `endTime + revealTimeout`, `seal()` unavailable | refunds, opens a fresh epoch |
| `cancelEpoch` | `sealedAt + revealTimeout`, still Sealed/Revealed | full refunds |
| `recoverEpoch` | `unwrapRequestedAt + unwrapTimeout`, residual released | residual re-wrapped, full refunds |
| `abandonEpoch` | `unwrapRequestedAt + 3×unwrapTimeout`, residual *never* released | internal cross settles; heavy side absorbs the loss. Refuses to run if the residual is recoverable, or if it would zero a funded side |

## Security model

- **Price manipulation:** both the internal cross and the residual swap require spot
  to sit within `maxTickDeviation` of the pool's `twapWindow` TWAP (`setPriceGuard`),
  so a flash loan cannot set the clearing rate. Ticks are log-space, so the check
  needs no price math (1 tick ≈ 1 bp). Disabled only when `twapWindow == 0`, which is
  valid solely on a pool without oracle history — the deploy script primes it.
- **Fund attribution:** each pending residual is tracked in `escrowedIn[token]`; every
  consumption path proves the balance covers *all* outstanding escrows, and
  `sweepDust` can only ever move `balance − escrowed`. One epoch can never spend
  another's custody, so settlements need not serialize (an earlier serialization
  design was removed after it was found to enable a protocol-wide DoS).
- **Privacy floor:** `seal()` refuses to publicly decrypt an aggregate for a side with
  fewer than `minOrders` participants — the epoch cancels for full refunds instead.
  Revealing a 1-participant "aggregate" would publish that user's exact order.
- **Parameter immutability:** every epoch snapshots its timeouts, slippage bound,
  privacy floor and auditor at open time, so owner changes can never retroactively
  alter an in-flight epoch or retroactively disclose historic orders to a new auditor.

## Honest limitations

- Order **direction and participation are public metadata**; only amounts are hidden.
- `buyCount`/`sellCount` are an **upper bound** on real participants: an ERC-7984
  transfer above the sender's balance silently moves 0 but still registers an order,
  so a sybil can inflate the counts `minOrders` gates on without committing capital.
  A capital-weighted floor is the production fix.
- Nox ACL has **no `removeViewer`** — auditor grants are permanent. Point `setAuditor`
  at a proxy contract if you need key rotation.
- The heavy side absorbs the Uniswap fee and price impact of the residual, while
  internally-crossed volume clears at the TWAP-validated pool price.
- Wrap/unwrap amounts at the wrapper boundary are public by nature; privacy applies
  inside the confidential domain.
- **Max residual size** is bounded by pool depth: the slippage floor caps a swap at
  ~2.8% of the input-side reserve (at 3% slippage). With the seeded 200k tUSDC /
  100 tWETH pool that is ~5,500 tUSDC or ~2.7 tWETH per epoch residual. Larger
  residuals revert `finalizeSettlement` and fall through to `recoverEpoch`.
