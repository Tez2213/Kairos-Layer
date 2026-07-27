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

## Operational notes

- `KEEPER_INTERVAL_MS` (default 20000) sets the tick rate.
- The health line each tick reports the current epoch, its state, participant counts
  and the keeper's remaining gas; it warns below 0.003 ETH.
- Failures are logged and retried on the next tick — a single bad tick never wedges
  the loop, and every contract call is idempotent and state-guarded.
- `ethers` is installed only because `@iexec-nox/handle` imports it unconditionally
  even on the viem path (see `feedback.md`); nothing here uses it.
