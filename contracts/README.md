# Kairos Layer — Contracts

Confidential dark pool on iExec Nox, settling residuals on Uniswap V3. See the root
`AGENTS.md` for the full architecture and threat model.

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
`finalizeSettlement(unwrapProof)` → `claim()`

Decryption proofs come from the Nox SDK (`publicDecrypt`) and are verified on-chain.
Every crank is permissionless. Liveness escapes: `cancelEpoch` (reveal timeout, full
refunds), `recoverEpoch` (unwrap finalized externally, full refunds), `abandonEpoch`
(TEE never decrypts the unwrap — internal cross only, heavy side absorbs the burned
residual pro-rata). Settlements are serialized: one epoch in `UnwrapPending` at a time.

## Security notes (honest limitations)

- Internal crossing prices off Uniswap **spot** (`slot0`) — flash-manipulable on
  mainnet; a TWAP oracle is the production upgrade. Fine for Sepolia demo.
- Order **direction and participation are public metadata**; only amounts are hidden.
- k-anonymity degrades in small epochs — the frontend warns below a threshold.
- Wrap/unwrap amounts at the wrapper boundary are public by nature; privacy applies
  inside the confidential domain.
