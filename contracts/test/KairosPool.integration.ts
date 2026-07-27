/**
 * KairosPool integration tests — run against the REAL local Nox TEE stack
 * (booted automatically by @iexec-nox/nox-hardhat-plugin on `hardhat test`).
 *
 * All transactions go through the `noxLocal` connection returned by `nox.connect()`:
 * that is the chain the off-chain Nox services (ingestor/runner/gateway/KMS) watch.
 * Encrypted values here are REAL handles resolved by the TEE — no mocks.
 *
 * NOTE: the plugin's `nox.encryptInput/decrypt` helpers are bound to the FIRST
 * signer, so a multi-user protocol needs one handle client per wallet — input
 * proofs bind the encrypting account and revert with "Owner mismatch" otherwise.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createViemHandleClient, type HandleClient } from "@iexec-nox/handle";
import { NOX_COMPUTE_ADDRESS, RPC_URL, handleGatewayUrl, nox } from "@iexec-nox/nox-hardhat-plugin";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Standard Hardhat/anvil test-mnemonic keys ("test test … junk").
 * The handle SDK resolves the proof owner via `walletClient.getAddresses()[0]`,
 * which for a JSON-RPC wallet returns the NODE's first account regardless of the
 * client's bound account — so per-user encryption requires LOCAL accounts.
 * Derived addresses are asserted against the node's accounts in `before`.
 */
const TEST_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];

const FactoryArtifact = JSON.parse(
  readFileSync(
    "node_modules/@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json",
    "utf8",
  ),
);

// ---------- pure helpers ----------

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** sqrtPriceX96 for a pool where price = token1 raw units per token0 raw unit. */
function encodeSqrtPriceX96(num: bigint, den: bigint): bigint {
  return isqrt((num * (1n << 192n)) / den);
}

const Q96 = 1n << 96n;
const FEE = 3000;
const MIN_TICK = -887220;
const MAX_TICK = 887220;

const USDC_DEC = 10n ** 6n;
const WETH_DEC = 10n ** 18n;
const PRICE_USDC_PER_WETH = 2000n;

const EPOCH_DURATION = 60n;
const REVEAL_TIMEOUT = 600n;
const UNWRAP_TIMEOUT = 300n;
const MAX_SLIPPAGE_BPS = 300;
const MIN_ORDERS = 2;

const enum State {
  None,
  Open,
  Sealed,
  Revealed,
  UnwrapPending,
  Distributable,
  Cancelled,
}

describe("KairosPool (local Nox stack + local Uniswap V3)", () => {
  let viem: any;
  let publicClient: any;
  let wallets: any[];
  let users: Address[];
  const handleClients = new Map<number, HandleClient>();

  let usdc: any;
  let weth: any;
  let cUSDC: any;
  let cWETH: any;
  let uniPoolAddress: Address;
  let pool: any;
  let quoteIsToken0: boolean;

  // ---------- Nox helpers (per-wallet) ----------

  async function clientFor(i: number): Promise<HandleClient> {
    const cached = handleClients.get(i);
    if (cached) return cached;
    const localWallet = createWalletClient({
      account: privateKeyToAccount(TEST_KEYS[i]),
      transport: http(RPC_URL),
    });
    const client = await createViemHandleClient(localWallet, {
      smartContractAddress: NOX_COMPUTE_ADDRESS,
      gatewayUrl: handleGatewayUrl(),
      subgraphUrl: "https://example.com/subgraphs/id/none",
    });
    handleClients.set(i, client);
    return client;
  }

  async function waitResolved(handles: Hex[]) {
    const url = `${handleGatewayUrl()}/v0/public/handles/status`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handles }),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const resolved = new Map<string, boolean>(
          data.payload.statuses.map((s: any) => [s.handle.toLowerCase(), s.resolved]),
        );
        if (handles.every((h) => resolved.get(h.toLowerCase()) === true)) return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`handles not resolved: ${handles.join(", ")}`);
  }

  async function decryptAs(i: number, handle: Hex): Promise<bigint> {
    await waitResolved([handle]);
    const client = await clientFor(i);
    return (await client.decrypt(handle)).value as bigint;
  }

  async function decryptBalance(token: any, i: number): Promise<bigint> {
    const handle = (await token.read.confidentialBalanceOf([users[i]])) as Hex;
    return decryptAs(i, handle);
  }

  // ---------- chain helpers ----------

  const rpc = (method: string, params: unknown[] = []) =>
    publicClient.request({ method: method as any, params: params as any });

  async function advanceTime(seconds: number) {
    await rpc("evm_increaseTime", [seconds]);
    await rpc("evm_mine", []);
  }

  async function write(contract: any, fn: string, args: unknown[] = [], account?: any) {
    const hash = account
      ? await contract.write[fn](args, { account })
      : await contract.write[fn](args);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * Tests that exercise timeouts push the clock past the *next* epoch's window, so
   * roll the (empty) expired epoch forward before submitting new orders.
   */
  async function ensureOpenEpoch() {
    const id = (await pool.read.currentEpochId()) as bigint;
    const e = await pool.read.getEpoch([id]);
    const now = (await publicClient.getBlock()).timestamp as bigint;
    if (e.state === State.Open && now >= (e.endTime as bigint)) {
      await write(pool, "seal");
    }
  }

  async function submitOrder(i: number, isBuy: boolean, amount: bigint) {
    const client = await clientFor(i);
    const { handle, handleProof } = await client.encryptInput(amount, "uint256", pool.address);
    await write(pool, "submitOrder", [isBuy, handle, handleProof], wallets[i].account);
  }

  async function sealAndReveal(): Promise<bigint> {
    const epochId = (await pool.read.currentEpochId()) as bigint;
    await advanceTime(Number(EPOCH_DURATION) + 1);
    await write(pool, "seal");
    const e = await pool.read.getEpoch([epochId]);
    if (e.state !== State.Sealed) return epochId;
    const buyProof =
      e.buyCount > 0 ? (await nox.publicDecrypt(e.buyTotalEnc as Hex)).decryptionProof : "0x";
    const sellProof =
      e.sellCount > 0 ? (await nox.publicDecrypt(e.sellTotalEnc as Hex)).decryptionProof : "0x";
    await write(pool, "reveal", [epochId, buyProof, sellProof]);
    return epochId;
  }

  /** Mirrors the contract's on-chain conversion so tests can predict netting exactly. */
  async function baseToQuote(baseAmount: bigint): Promise<bigint> {
    const slot0 = (await publicClient.readContract({
      address: uniPoolAddress,
      abi: [
        {
          type: "function",
          name: "slot0",
          inputs: [],
          outputs: [
            { name: "sqrtPriceX96", type: "uint160" },
            { name: "tick", type: "int24" },
            { name: "observationIndex", type: "uint16" },
            { name: "observationCardinality", type: "uint16" },
            { name: "observationCardinalityNext", type: "uint16" },
            { name: "feeProtocol", type: "uint8" },
            { name: "unlocked", type: "bool" },
          ],
          stateMutability: "view",
        },
      ] as const,
      functionName: "slot0",
    })) as readonly [bigint, ...unknown[]];
    const priceX96 = (slot0[0] * slot0[0]) / Q96;
    return quoteIsToken0
      ? (baseAmount * Q96) / priceX96
      : (baseAmount * priceX96) / Q96;
  }

  before(async () => {
    const connection = await nox.connect();
    viem = (connection as any).viem;
    publicClient = await viem.getPublicClient();
    wallets = await viem.getWalletClients();
    users = wallets.map((w: any) => w.account.address);
    // Fail loudly if the node's accounts ever stop matching the test mnemonic,
    // rather than producing confusing "Owner mismatch" reverts later.
    for (let i = 0; i < TEST_KEYS.length; i++) {
      assert.equal(
        privateKeyToAccount(TEST_KEYS[i]).address.toLowerCase(),
        users[i].toLowerCase(),
        `TEST_KEYS[${i}] does not match node account ${i}`,
      );
    }

    usdc = await viem.deployContract("TestUSDC");
    weth = await viem.deployContract("TestWETH");
    quoteIsToken0 = usdc.address.toLowerCase() < weth.address.toLowerCase();

    // --- real Uniswap V3 factory + pool from canonical artifacts ---
    const factoryHash = await wallets[0].deployContract({
      abi: FactoryArtifact.abi,
      bytecode: FactoryArtifact.bytecode as Hex,
    });
    const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryHash });
    const factoryAddress = factoryReceipt.contractAddress as Address;

    await publicClient.waitForTransactionReceipt({
      hash: await wallets[0].writeContract({
        address: factoryAddress,
        abi: FactoryArtifact.abi,
        functionName: "createPool",
        args: [usdc.address, weth.address, FEE],
      }),
    });
    uniPoolAddress = (await publicClient.readContract({
      address: factoryAddress,
      abi: FactoryArtifact.abi,
      functionName: "getPool",
      args: [usdc.address, weth.address, FEE],
    })) as Address;

    const sqrtPriceX96 = quoteIsToken0
      ? encodeSqrtPriceX96(WETH_DEC, PRICE_USDC_PER_WETH * USDC_DEC)
      : encodeSqrtPriceX96(PRICE_USDC_PER_WETH * USDC_DEC, WETH_DEC);
    const poolAbi = [
      {
        type: "function",
        name: "initialize",
        inputs: [{ name: "sqrtPriceX96", type: "uint160" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
      {
        type: "function",
        name: "increaseObservationCardinalityNext",
        inputs: [{ name: "n", type: "uint16" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ] as const;
    await publicClient.waitForTransactionReceipt({
      hash: await wallets[0].writeContract({
        address: uniPoolAddress,
        abi: poolAbi,
        functionName: "initialize",
        args: [sqrtPriceX96],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await wallets[0].writeContract({
        address: uniPoolAddress,
        abi: poolAbi,
        functionName: "increaseObservationCardinalityNext",
        args: [10],
      }),
    });

    // --- seed deep liquidity: 200k tUSDC / 100 tWETH, full range ---
    const seeder = await viem.deployContract("UniswapSeeder");
    const usdcSeed = 200_000n * USDC_DEC;
    const wethSeed = 100n * WETH_DEC;
    await write(usdc, "faucet", [1_000_000n * USDC_DEC]);
    await write(weth, "faucet", [1_000n * WETH_DEC]);
    await write(usdc, "transfer", [seeder.address, usdcSeed + 10n * USDC_DEC]);
    await write(weth, "transfer", [seeder.address, wethSeed]);
    await write(seeder, "seed", [uniPoolAddress, MIN_TICK, MAX_TICK, isqrt(usdcSeed * wethSeed)]);
    // Oracle history for the TWAP deviation guard.
    await write(seeder, "prime", [uniPoolAddress, quoteIsToken0, 1n * USDC_DEC]);
    await write(seeder, "prime", [uniPoolAddress, quoteIsToken0, 1n * USDC_DEC]);

    cUSDC = await viem.deployContract("KairosWrappedToken", [
      "Confidential tUSDC",
      "cUSDC",
      "",
      usdc.address,
    ]);
    cWETH = await viem.deployContract("KairosWrappedToken", [
      "Confidential tWETH",
      "cWETH",
      "",
      weth.address,
    ]);
    pool = await viem.deployContract("KairosPool", [
      cUSDC.address,
      cWETH.address,
      uniPoolAddress,
      EPOCH_DURATION,
      REVEAL_TIMEOUT,
      UNWRAP_TIMEOUT,
      MAX_SLIPPAGE_BPS,
      MIN_ORDERS,
      users[0],
    ]);
    await write(pool, "setPriceGuard", [60, 500]);

    // --- fund four users and authorize the pool as ERC-7984 operator ---
    const until = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
    for (let i = 0; i < 4; i++) {
      const acct = wallets[i].account;
      if (i > 0) {
        await write(usdc, "transfer", [users[i], 10_000n * USDC_DEC]);
        await write(weth, "transfer", [users[i], 5n * WETH_DEC]);
      }
      await write(usdc, "approve", [cUSDC.address, 10_000n * USDC_DEC], acct);
      await write(cUSDC, "wrap", [users[i], 10_000n * USDC_DEC], acct);
      await write(weth, "approve", [cWETH.address, 4n * WETH_DEC], acct);
      await write(cWETH, "wrap", [users[i], 4n * WETH_DEC], acct);
      await write(cUSDC, "setOperator", [pool.address, until], acct);
      await write(cWETH, "setOperator", [pool.address, until], acct);
    }
  });

  it("runs a full epoch: 2 buyers + 2 sellers → netting → residual swap → pro-rata claims", async () => {
    const buy1 = 1_000n * USDC_DEC;
    const buy2 = 500n * USDC_DEC;
    const sell1 = WETH_DEC / 5n; // 0.2 tWETH ≈ 400 tUSDC
    const sell2 = WETH_DEC / 10n; // 0.1 tWETH ≈ 200 tUSDC

    await submitOrder(0, true, buy1);
    await submitOrder(1, true, buy2);
    await submitOrder(2, false, sell1);
    await submitOrder(3, false, sell2);

    const cwethBefore0 = await decryptBalance(cWETH, 0);
    const cusdcBefore2 = await decryptBalance(cUSDC, 2);

    const epochId = await sealAndReveal();
    let e = await pool.read.getEpoch([epochId]);
    assert.equal(e.state, State.Revealed);
    assert.equal(e.buyTotal, buy1 + buy2); // actual-transferred accounting
    assert.equal(e.sellTotal, sell1 + sell2);

    await write(pool, "initiateSettlement", [epochId]);
    e = await pool.read.getEpoch([epochId]);
    assert.equal(e.state, State.UnwrapPending);
    assert.equal(e.residual, 1); // BuyHeavy
    assert.ok(e.residualIn > 890n * USDC_DEC && e.residualIn < 910n * USDC_DEC);
    // Escrow protects the in-flight residual from sweeps and other epochs.
    assert.equal(await pool.read.escrowedIn([usdc.address]), e.residualIn);

    const unwrapDec = await nox.publicDecrypt(e.unwrapRequestId as Hex);
    assert.equal(unwrapDec.value, e.residualIn);
    await write(pool, "finalizeSettlement", [epochId, unwrapDec.decryptionProof, 0n]);
    e = await pool.read.getEpoch([epochId]);
    assert.equal(e.state, State.Distributable);
    assert.equal(await pool.read.escrowedIn([usdc.address]), 0n);
    assert.ok(e.buyOutTotal > sell1 + sell2); // crossed base + swap output

    // Pro-rata payouts, computed on encrypted operands inside the TEE.
    await write(pool, "claim", [epochId], wallets[0].account);
    const expected0 = (buy1 * (e.buyOutTotal as bigint)) / (e.buyTotal as bigint);
    assert.equal(await decryptBalance(cWETH, 0), cwethBefore0 + expected0);

    await write(pool, "claim", [epochId], wallets[2].account);
    const expected2 = (sell1 * (e.sellOutTotal as bigint)) / (e.sellTotal as bigint);
    assert.equal(await decryptBalance(cUSDC, 2), cusdcBefore2 + expected2);

    await assert.rejects(pool.write.claim([epochId], { account: wallets[0].account }));
  });

  it("crosses perfectly without touching Uniswap when the sides match exactly", async () => {
    const sell1 = WETH_DEC / 10n;
    const sell2 = WETH_DEC / 20n;
    await submitOrder(2, false, sell1);
    await submitOrder(3, false, sell2);

    // Size the buy side to exactly the sell side's quote value → residual == 0.
    const exact = await baseToQuote(sell1 + sell2);
    await submitOrder(0, true, exact - 1n);
    await submitOrder(1, true, 1n);

    const epochId = await sealAndReveal();
    const usdcBalBefore = await usdc.read.balanceOf([uniPoolAddress]);

    await write(pool, "initiateSettlement", [epochId]);
    const e = await pool.read.getEpoch([epochId]);
    assert.equal(e.residual, 0); // NoResidual
    assert.equal(e.state, State.Distributable); // settled in a single transaction
    assert.equal(e.buyOutTotal, sell1 + sell2);
    assert.equal(e.sellOutTotal, exact);
    // Nothing reached the public market.
    assert.equal(await usdc.read.balanceOf([uniPoolAddress]), usdcBalBefore);
  });

  it("refuses to reveal an epoch too small to hide its participants (privacy guard)", async () => {
    await submitOrder(0, true, 300n * USDC_DEC); // a single buyer
    const before = await decryptBalance(cUSDC, 0);

    const epochId = (await pool.read.currentEpochId()) as bigint;
    await advanceTime(Number(EPOCH_DURATION) + 1);
    await write(pool, "seal");

    const e = await pool.read.getEpoch([epochId]);
    assert.equal(e.state, State.Cancelled); // never revealed
    assert.equal(e.buyTotal, 0n);

    await write(pool, "claimRefund", [epochId], wallets[0].account);
    assert.equal(await decryptBalance(cUSDC, 0), before + 300n * USDC_DEC);
  });

  it("cancelOrder refunds confidentially and decrements the participant count", async () => {
    const epochId = (await pool.read.currentEpochId()) as bigint;
    const before = await decryptBalance(cUSDC, 0);

    await submitOrder(0, true, 50n * USDC_DEC);
    await write(pool, "cancelOrder", [true], wallets[0].account);

    assert.equal(await decryptBalance(cUSDC, 0), before);
    assert.equal((await pool.read.getEpoch([epochId])).buyCount, 0);
  });

  it("keeps a stored order handle decryptable by its owner in a later transaction", async () => {
    const epochId = (await pool.read.currentEpochId()) as bigint;
    const amount = 123n * USDC_DEC;
    await submitOrder(1, true, amount);

    // Persistent-ACL check: read the stored handle in a LATER tx and decrypt as owner.
    const handle = (await pool.read.orderOf([epochId, users[1], true])) as Hex;
    assert.equal(await decryptAs(1, handle), amount);

    // A different account must NOT be able to decrypt it.
    await waitResolved([handle]);
    const stranger = await clientFor(2);
    await assert.rejects(stranger.decrypt(handle));

    await write(pool, "cancelOrder", [true], wallets[1].account);
  });

  it("cancels a stuck epoch after the reveal timeout and refunds everyone", async () => {
    await submitOrder(0, true, 200n * USDC_DEC);
    await submitOrder(1, true, 100n * USDC_DEC);
    const before0 = await decryptBalance(cUSDC, 0);

    const epochId = (await pool.read.currentEpochId()) as bigint;
    await advanceTime(Number(EPOCH_DURATION) + 1);
    await write(pool, "seal");
    assert.equal((await pool.read.getEpoch([epochId])).state, State.Sealed);

    await assert.rejects(pool.write.cancelEpoch([epochId])); // too early
    await advanceTime(Number(REVEAL_TIMEOUT) + 1);
    await write(pool, "cancelEpoch", [epochId]);
    assert.equal((await pool.read.getEpoch([epochId])).state, State.Cancelled);

    await write(pool, "claimRefund", [epochId], wallets[0].account);
    assert.equal(await decryptBalance(cUSDC, 0), before0 + 200n * USDC_DEC);
    await assert.rejects(pool.write.claimRefund([epochId], { account: wallets[0].account }));
  });

  it("recovers a settlement whose swap can never clear, refunding in full", async () => {
    await ensureOpenEpoch();
    await submitOrder(0, true, 400n * USDC_DEC);
    await submitOrder(1, true, 200n * USDC_DEC);
    const before0 = await decryptBalance(cUSDC, 0);

    const epochId = await sealAndReveal();
    await write(pool, "initiateSettlement", [epochId]);
    let e = await pool.read.getEpoch([epochId]);
    assert.equal(e.state, State.UnwrapPending);

    // Release the residual, but never complete the swap (unreachable minOut).
    const unwrapDec = await nox.publicDecrypt(e.unwrapRequestId as Hex);
    await assert.rejects(
      pool.write.finalizeSettlement([epochId, unwrapDec.decryptionProof, 100n * WETH_DEC]),
    );

    await assert.rejects(pool.write.recoverEpoch([epochId])); // timeout not reached
    await advanceTime(Number(UNWRAP_TIMEOUT) + 1);
    // Anyone may finalize the unwrap on the wrapper; the pool then re-wraps it.
    await write(cUSDC, "finalizeUnwrap", [e.unwrapRequestId, unwrapDec.decryptionProof]);
    await write(pool, "recoverEpoch", [epochId]);

    e = await pool.read.getEpoch([epochId]);
    assert.equal(e.state, State.Cancelled);
    assert.equal(await pool.read.escrowedIn([usdc.address]), 0n);

    await write(pool, "claimRefund", [epochId], wallets[0].account);
    assert.equal(await decryptBalance(cUSDC, 0), before0 + 400n * USDC_DEC);
  });

  it("rejects cranks in the wrong state and unreachable timeouts", async () => {
    await ensureOpenEpoch(); // a fresh, still-running epoch
    const epochId = (await pool.read.currentEpochId()) as bigint;
    await assert.rejects(pool.write.reveal([epochId, "0x", "0x"])); // not sealed
    await assert.rejects(pool.write.initiateSettlement([epochId])); // not revealed
    await assert.rejects(pool.write.seal()); // window not elapsed
    await assert.rejects(pool.write.claim([epochId])); // not distributable
    await assert.rejects(pool.write.emergencyCancelOpenEpoch()); // timeout not reached
    await assert.rejects(pool.write.recoverEpoch([epochId])); // not unwrap-pending
    await assert.rejects(pool.write.abandonEpoch([epochId])); // not unwrap-pending
  });

  it("rejects out-of-bounds parameters and keeps escrow safe from sweeps", async () => {
    // Timeouts bounded on both sides; slippage floor above the Uniswap fee.
    await assert.rejects(pool.write.setEpochParams([60n, 60n, 300n, 300, 2])); // reveal too short
    await assert.rejects(pool.write.setEpochParams([60n, 600n, 300n, 10, 2])); // slippage too low
    await assert.rejects(pool.write.setEpochParams([60n, 600n, 300n, 300, 0])); // minOrders 0

    const dustBefore = (await pool.read.sweepableDust([usdc.address])) as bigint;
    await write(usdc, "transfer", [pool.address, 7n * USDC_DEC]);
    assert.equal(await pool.read.sweepableDust([usdc.address]), dustBefore + 7n * USDC_DEC);
    await write(pool, "sweepDust", [usdc.address, users[0]]);
    assert.equal(await pool.read.sweepableDust([usdc.address]), 0n);
  });
});
