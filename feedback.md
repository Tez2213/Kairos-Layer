# iExec Nox — Developer Feedback (Kairos Layer, WTF Hackathon)

Running log of real friction and wins encountered while building a confidential dark
pool on Nox. Kept chronologically during development, not backfilled.

## Documentation

1. **Solidity version mismatch between docs and package.** The docs say Solidity
   `0.8.27+`, but `@iexec-nox/nox-protocol-contracts@0.2.4` ships `Nox.sol` with
   `pragma solidity ^0.8.35`. First compile fails until you discover this. Suggest the
   docs state the exact minimum per package version.
2. **`nox-hardhat-plugin` GitHub README is stale.** It still contains the Hardhat
   plugin *template* text ("Hola, Hardhat!"), with a `<!-- TODO update readme -->`
   marker. The real usage doc only exists on the docs site — took a detour to
   discover the plugin is real and working.
3. **Foundry guide is a "Coming Soon" placeholder.** We initially chose Foundry and
   had to switch to Hardhat after discovering there is no local TEE stack or test
   helper for it. Even a paragraph saying "not supported yet, use Hardhat" would
   save teams a day.
4. **The Networks docs page is client-rendered** — contract addresses aren't in the
   HTML payload, so nothing is greppable/scriptable. A static table (or JSON file in
   a repo) with NoxCompute addresses per chain would help. We ended up reading the
   addresses out of `Nox.sol`.
5. **Address drift between GitHub `main` and the npm release.** The local-chain
   (31337) NoxCompute address in `Nox.sol` on GitHub main differs from the one in the
   published npm package (`0x8289…` vs `0x75C6…`). Pin your reading to `node_modules`,
   not the repo. Worth a note in the docs.

## Solidity / contracts DX

6. **`delete` doesn't work on user-defined value types.** `delete mapping[user]`
   where the value is `euint256` fails to compile (`Built-in unary operator delete
   cannot be applied to type euint256`); you must write `mapping[user] = euint256.wrap(0)`.
   Minor, but surprising.
7. **The transient-ACL model is the #1 footgun, and the compiler can't help.**
   Forgetting `Nox.allowThis()` after a handle-producing op produces no error at
   write time — the handle is just unusable in the next transaction. A lint rule,
   static analyzer, or debug mode that flags handles that end a transaction without
   persistent ACL would be a huge DX win.
8. **Big win: `confidentialTransferFrom` returns the *actual* transferred handle.**
   The silent-zero (safeSub) semantics could easily cause credit-inflation bugs in
   integrating contracts; returning the actual amount makes safe accounting natural.
   More prominent doc emphasis on "always use the returned handle" would help others.
9. **Win: `Nox.publicDecrypt(handle, proof)` verifies TEE decryption proofs
   on-chain.** This unlocked our whole aggregate-reveal design (trustless crank:
   anyone can post the proof, nobody can forge totals). It deserves top billing in
   the docs — we only found it by reading `Nox.sol`.

## Hardhat plugin

10. **Win: the plugin's local stack is excellent** — `hardhat test` boots the full
    TEE pipeline (ingestor/runner/gateway/KMS) in Docker with zero config, and the
    `nox` helper mirrors the production SDK (`encryptInput`/`decrypt`/`publicDecrypt`
    with proofs). Real encrypted ops in local tests instead of mocks.
11. **Test transactions must go through `nox.connect()`'s connection** (the
    `noxLocal` HTTP network) — anything on the default in-process network is
    invisible to the off-chain services. This is only discoverable by reading the
    plugin source; a doc note + an error hint would save confusion.

12. **Win: the local stack is fast.** A full confidential epoch lifecycle — two
    encrypted order submissions, aggregate public decryption with on-chain proof
    verification, a wrapper unwrap round-trip, a Uniswap V3 swap, re-wrap, and an
    encrypted pro-rata claim — completes in ~2 seconds locally. Great iteration loop.
13. **Public handles work seamlessly where ACL checks apply.** Passing a
    `Nox.toEuint256(plaintextValue)` public handle into `wrapper.unwrap()` (which
    requires `Nox.isAllowed`) works as expected — public handles are treated as
    accessible by everyone. This behavior is load-bearing for integrators (it's how a
    contract unwraps a publicly-known residual) but is only documented implicitly.
14. **Gateway failure modes could be friendlier.** When the local MinIO volume filled
    up (full disk), the gateway returned an opaque
    `Storage error: S3 operation failed: unhandled error (XMinioStorageFull)` and
    handle resolution silently stalled. A health check on `hardhat test` startup
    ("storage: low disk space") would have saved a debugging cycle.

15. **BUG: `ViemBlockchainService.getAddress()` ignores the wallet client's bound
    account.** It returns `walletClient.getAddresses()[0]`
    (`src/services/blockchain/ViemBlockchainService.ts:64-71`), and for a
    JSON-RPC-account client (`eth_accounts`) that is the **node's first account**, not
    the account the client was created with. Since `encryptInput` uses it as the proof
    `owner` while `signTypedData` correctly prefers `walletClient.account`, the proof
    is *signed by* account N but *owned by* account 0 — every multi-user flow reverts
    with an opaque `Owner mismatch`. Note the two code paths disagree with each other
    inside the same class. Workaround: build clients from **local** accounts
    (`privateKeyToAccount`) so `getAddresses()` returns the bound account. Suggested
    fix: `this.walletClient.account?.address ?? (await getAddresses())[0]`.
    Compounding this, the plugin's `nox` helper is hard-bound to
    `getWalletClients()[0]` (`utils/handle-client.ts`), so it cannot act as any other
    user; an optional signer argument would make multi-party tests straightforward.
16. **Custom errors from NoxCompute don't decode in Hardhat/viem test output.** Failures
    surface as `reverted with an unrecognized custom error (return data: 0x...)`, and
    the reason string is only visible by hand-decoding the ABI-encoded tail. Exporting
    the NoxCompute ABI (or error selectors) from the plugin would make failures
    self-explanatory.
17. **`Nox.addViewer` reverts on public handles while `allow`/`allowThis` silently
    skip them.** `Nox.sol`'s `_allowIfNotPublic` guards the latter, but `addViewer`
    calls straight through to `ACL.addViewer`, which carries `notPublicHandle`. That
    asymmetry is a latent trap when adding an auditor/viewer feature to code that
    also handles public handles; worth a note in the Solidity reference.
18. **Wanted: a "handle liveness" debug helper.** The single most dangerous mistake in
    this protocol was forgetting persistent ACL on a handle that must survive to a
    later transaction. A test-time assertion (e.g. `nox.assertUsableNextTx(handle)`)
    or a warning when a transaction ends with handles that only ever received
    transient grants would eliminate an entire bug class.

*(log continues as development proceeds)*
