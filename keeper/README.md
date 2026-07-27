# Kairos Keeper

Drives epochs to settlement without supervision.

Every action the keeper takes is **permissionless** — it holds no privilege the
contract does not grant to any address. It is a convenience, never a trust
assumption: if every keeper stops, the contract's timeouts still let users recover
their funds themselves.

## Run

```bash
npm install
npm run dry      # single pass, reports what it would do, sends nothing
npm run once     # single pass, live (good for cron)
npm start        # run forever
```

Reads `KEEPER_PRIVATE_KEY` (falling back to `SEPOLIA_PRIVATE_KEY`) and optionally
`SEPOLIA_RPC_URL` from `../contracts/.env`. Use a dedicated burner key funded with a
little Sepolia ETH — the keeper only ever calls settlement functions, never anything
that touches user balances.

## What one tick does

1. **Seal** any epoch whose order window has closed
2. **Reveal** sealed epochs — fetches enclave proofs for both side totals
3. **Net** revealed epochs against each other
4. **Finalize** pending unwraps: release the residual, swap it on Uniswap, re-shield
5. **Rescue** anything stuck past its timeout, so funds are never stranded

Steps 2 and 4 wait on the trusted enclave, which takes tens of seconds on a live
network; the keeper polls patiently rather than failing.

## Running it in production (no server needed)

`.github/workflows/keeper.yml` runs `npm run once` every 5 minutes on GitHub's
runners. Add two repository secrets and it is live:

| Secret | Value |
| --- | --- |
| `KEEPER_PRIVATE_KEY` | a burner key holding only gas |
| `SEPOLIA_RPC_URL` | optional; a dedicated endpoint |

This is a real deployment, not a demo shortcut: the workflow is public, so anyone
can see settlement is automated, and the run history is evidence it keeps working.
Secrets are not exposed to fork pull requests, and the key is powerless beyond
paying gas.

Alternatives if you prefer: any always-on VM under `systemd`/`pm2` running
`npm start`. Avoid serverless functions — the enclave round-trip during `reveal`
can exceed a function's execution limit.

### Why gas cost is bounded

Sealing costs ~120k gas, and an epoch that expires must be sealed before the next
opens. Rolling an idle pool every few minutes would burn ~0.06 ETH/day for nobody:

| Epoch length | Seals/day if rolled eagerly | Cost/day |
| --- | --- | --- |
| 3 min | 480 | ~0.059 ETH |
| 10 min | 144 | ~0.018 ETH |
| 30 min | 48 | ~0.006 ETH |

So the keeper seals **immediately when a batch has orders** (users are waiting) but
lets **empty** batches age, rolling them only every `KEEPER_SEAL_EMPTY_AFTER_S`
seconds (default 1800). A trader arriving at an expired empty batch can open the
next one themselves from the trade page for the same trivial gas. Cost therefore
tracks usage rather than the clock.

## Operational notes

- `KEEPER_INTERVAL_MS` (default 20000) sets the tick rate.
- The health line each tick reports the current epoch, its state, participant counts
  and the keeper's remaining gas; it warns below 0.003 ETH.
- Failures are logged and retried on the next tick — a single bad tick never wedges
  the loop, and every contract call is idempotent and state-guarded.
- `ethers` is installed only because `@iexec-nox/handle` imports it unconditionally
  even on the viem path (see `feedback.md`); nothing here uses it.
