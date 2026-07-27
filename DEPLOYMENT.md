# Deploying Kairos Layer

The contracts are **already deployed and verified** on Ethereum Sepolia, so a full
deployment is two steps: publish the frontend, and switch on the keeper.

Total required configuration: **one secret.**

---

## What needs what

| Component | Required config | Why |
| --- | --- | --- |
| **Frontend** (Vercel) | *nothing* | Addresses are compiled in; Nox endpoints come from the SDK; RPC falls back across public nodes |
| **Keeper** (GitHub Actions) | `KEEPER_PRIVATE_KEY` | It must sign settlement transactions |
| **Contracts** | already deployed | Only needed again if you redeploy |

---

## 1. Frontend → Vercel

1. Push the repo to GitHub (public — it is a hackathon deliverable).
2. In Vercel: **Add New → Project**, import the repo.
3. Set **Root Directory** to `frontend`. Everything else is auto-detected.
4. Deploy. **Add no environment variables.**

Verify by opening the deployment and checking that:

- the home page shows a live epoch number and pool depth (not dashes),
- `/proof` runs and reports **0 leaks**,
- `/epochs` lists real settled batches.

If those work, the frontend is talking to Sepolia and to the iExec enclave correctly.

<details>
<summary>Optional: use your own RPC</summary>

Only worth doing under heavy traffic. Add `SEPOLIA_RPC_URL` (**without** the
`NEXT_PUBLIC_` prefix) so the key stays server-side and reads route through
`/api/rpc`. Never put an unrestricted key in a `NEXT_PUBLIC_` variable — those are
embedded in the JavaScript bundle.
</details>

---

## 2. Keeper → GitHub Actions

Without a keeper the app stops accepting orders once a batch expires, because a
new one only opens when someone calls `seal()`.

### Create a keeper wallet

Make a **fresh** wallet — do not reuse the deployer key. The deployer owns the
contract; a leaked owner key would expose `setEpochParams`, `setAuditor` and
`sweepDust`. A keeper key can do nothing except pay gas for calls anyone is
allowed to make.

Fund it with **~0.1 Sepolia ETH** ([Google Cloud faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)).

### Add the secret

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
| --- | --- |
| `KEEPER_PRIVATE_KEY` | the burner key, `0x…` (64 hex chars) |

`SEPOLIA_RPC_URL` is optional; leave it unset.

### Turn it on

The workflow at `.github/workflows/keeper.yml` runs every 5 minutes. Enable Actions
on the repo, then trigger it once by hand: **Actions → Settlement keeper → Run
workflow**. A successful run logs the current epoch, its state and the keeper's gas
balance.

> Secrets are not exposed to pull requests from forks, so a public repo is safe.

---

## 3. Check it end to end

Against the deployed site, in order:

1. `/start` — mint tUSDC, wrap it, authorise the pool (3 transactions)
2. `/trade` — submit an encrypted order; confirm the chain shows a handle, not a number
3. Repeat from a second wallet on the opposite side (the privacy floor needs 2 per side)
4. `/settle` — seal, reveal, net, swap (or wait for the keeper)
5. `/balances` — claim, then decrypt your payout
6. `/proof` — re-run; the new order appears and the verdict stays **0 leaks**

That path exercises the browser encryption, the enclave round-trips, the real
Uniswap swap and the access-control boundary — everything the project claims.

---

## Operating notes

**Gas.** Sealing costs ~120k gas and an expired batch must be sealed before the next
opens. The keeper therefore seals immediately when a batch holds orders, but lets
*empty* batches age and rolls them only every 30 minutes
(`KEEPER_SEAL_EMPTY_AFTER_S`). Idle cost is ~0.006 ETH/day; a trader arriving at an
expired batch can open the next one themselves from `/trade` for the same trivial
gas. Watch the balance warning in the keeper logs.

**Batch length.** Currently 3 minutes, which suits a demo. For a live site 10–15
minutes batches better and costs less; change it with `setEpochParams` from the
owner wallet. Existing epochs keep the parameters they opened with.

**If the keeper stops.** Nothing is lost. Every settlement function is
permissionless, so users can settle from `/settle`, and the contract's timeouts
guarantee refunds regardless.

**Redeploying contracts.** Only if you change Solidity: fill `contracts/.env`, run
`npx hardhat run scripts/deploy-sepolia.ts --network sepolia`, then regenerate
`frontend/lib/generated.ts` from the new `deployments.json` and update
`POOL_DEPLOY_BLOCK` in `frontend/lib/prover.ts`.
