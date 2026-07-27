/**
 * KairosPool integration tests — run against the REAL local Nox TEE stack
 * (booted automatically by @iexec-nox/nox-hardhat-plugin on `hardhat test`).
 *
 * All transactions go through the `noxLocal` connection returned by `nox.connect()`:
 * that is the chain the off-chain Nox services (ingestor/runner/gateway/KMS) watch.
 * Encrypted values here are REAL handles resolved by the TEE — no mocks.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nox } from "@iexec-nox/nox-hardhat-plugin";
import type { Address, Hex } from "viem";

const FactoryArtifact = JSON.parse(
  readFileSync(
    "node_modules/@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json",
    "utf8",
  ),
);

// ---------- helpers ----------

function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** sqrtPriceX96 for a pool where `price` = token1 raw units per 1 raw unit of token0, as a fraction num/den. */
function encodeSqrtPriceX96(num: bigint, den: bigint): bigint {
  // sqrt(num/den) * 2^96 = sqrt(num * 2^192 / den)
  return isqrt((num * (1n << 192n)) / den);
}

const FEE = 3000;
const TICK_SPACING = 60n;
const MIN_TICK = -887220; // full range for 0.3% fee tier
const MAX_TICK = 887220;

const USDC_DEC = 10n ** 6n;
const WETH_DEC = 10n ** 18n;
// 1 WETH = 2000 tUSDC
const PRICE_USDC_PER_WETH = 2000n;

describe("KairosPool (local Nox stack + local Uniswap V3)", () => {
  let connection: Awaited<ReturnType<typeof nox.connect>>;
  let viem: any;
  let publicClient: any;
  let wallet: any;
  let user: Address;

  let usdc: any;
  let weth: any;
  let cUSDC: any;
  let cWETH: any;
  let uniPoolAddress: Address;
  let pool: any;

  const rpc = (method: string, params: unknown[] = []) =>
    publicClient.request({ method: method as any, params: params as any });

  async function advanceTime(seconds: number) {
    await rpc("evm_increaseTime", [seconds]);
    await rpc("evm_mine", []);
  }

  async function write(contract: any, fn: string, args: unknown[] = []) {
    const hash = await contract.write[fn](args);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  before(async () => {
    connection = await nox.connect();
    viem = (connection as any).viem;
    publicClient = await viem.getPublicClient();
    [wallet] = await viem.getWalletClients();
    user = wallet.account.address;

    // --- public tokens ---
    usdc = await viem.deployContract("TestUSDC");
    weth = await viem.deployContract("TestWETH");

    // --- real Uniswap V3 factory + pool, deployed from canonical artifacts ---
    const factoryHash = await wallet.deployContract({
      abi: FactoryArtifact.abi,
      bytecode: FactoryArtifact.bytecode as Hex,
    });
    const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryHash });
    const factoryAddress = factoryReceipt.contractAddress as Address;

    const createHash = await wallet.writeContract({
      address: factoryAddress,
      abi: FactoryArtifact.abi,
      functionName: "createPool",
      args: [usdc.address, weth.address, FEE],
    });
    await publicClient.waitForTransactionReceipt({ hash: createHash });
    uniPoolAddress = (await publicClient.readContract({
      address: factoryAddress,
      abi: FactoryArtifact.abi,
      functionName: "getPool",
      args: [usdc.address, weth.address, FEE],
    })) as Address;

    // --- initialize price (depends on token ordering) ---
    const usdcIsToken0 = usdc.address.toLowerCase() < weth.address.toLowerCase();
    // price = token1 per token0 in raw units
    const sqrtPriceX96 = usdcIsToken0
      ? encodeSqrtPriceX96(WETH_DEC, PRICE_USDC_PER_WETH * USDC_DEC) // WETH per USDC
      : encodeSqrtPriceX96(PRICE_USDC_PER_WETH * USDC_DEC, WETH_DEC); // USDC per WETH

    const poolAbi = [
      {
        type: "function",
        name: "initialize",
        inputs: [{ name: "sqrtPriceX96", type: "uint160" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ] as const;
    const initHash = await wallet.writeContract({
      address: uniPoolAddress,
      abi: poolAbi,
      functionName: "initialize",
      args: [sqrtPriceX96],
    });
    await publicClient.waitForTransactionReceipt({ hash: initHash });

    // --- seed liquidity: ~200k tUSDC / ~100 WETH full range ---
    const seeder = await viem.deployContract("UniswapSeeder");
    const usdcSeed = 200_000n * USDC_DEC;
    const wethSeed = 100n * WETH_DEC;
    await write(usdc, "faucet", [1_000_000n * USDC_DEC]);
    await write(weth, "faucet", [1_000n * WETH_DEC]);
    await write(usdc, "transfer", [seeder.address, usdcSeed]);
    await write(weth, "transfer", [seeder.address, wethSeed]);
    const liquidity = isqrt(usdcSeed * wethSeed);
    await write(seeder, "seed", [uniPoolAddress, MIN_TICK, MAX_TICK, liquidity]);

    // --- confidential wrappers + the dark pool ---
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
      60n, // epochDuration: 1 min (test)
      600n, // revealTimeout: 10 min
      300, // maxSlippageBps: 3%
      user,
    ]);

    // --- user setup: wrap into confidential tokens, authorize the pool as operator ---
    await write(usdc, "approve", [cUSDC.address, 2_000n * USDC_DEC]);
    await write(cUSDC, "wrap", [user, 2_000n * USDC_DEC]);
    await write(weth, "approve", [cWETH.address, WETH_DEC / 2n]); // 0.5 WETH
    await write(cWETH, "wrap", [user, WETH_DEC / 2n]);
    const until = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
    await write(cUSDC, "setOperator", [pool.address, until]);
    await write(cWETH, "setOperator", [pool.address, until]);
  });

  it("runs a full epoch: encrypted orders → netting → residual swap → claims", async () => {
    const buyAmount = 1_000n * USDC_DEC; // buy WETH with 1000 tUSDC
    const sellAmount = WETH_DEC / 5n; // sell 0.2 WETH (≈400 tUSDC at spot)

    // Amounts encrypted client-side, bound to the pool address — calldata carries
    // only handles + proofs, never plaintext.
    const buyEnc = await nox.encryptInput(buyAmount, "uint256", pool.address);
    await write(pool, "submitOrder", [true, buyEnc.handle, buyEnc.handleProof]);
    const sellEnc = await nox.encryptInput(sellAmount, "uint256", pool.address);
    await write(pool, "submitOrder", [false, sellEnc.handle, sellEnc.handleProof]);

    // Seal after the epoch window.
    await advanceTime(61);
    await write(pool, "seal");
    let epoch = await pool.read.getEpoch([1n]);
    assert.equal(epoch.state, 2); // Sealed
    assert.equal(epoch.buyCount, 1);
    assert.equal(epoch.sellCount, 1);

    // Reveal ONLY the aggregates via TEE public decryption (proofs verified on-chain).
    const buyDec = await nox.publicDecrypt(epoch.buyTotalEnc as Hex);
    const sellDec = await nox.publicDecrypt(epoch.sellTotalEnc as Hex);
    assert.equal(buyDec.value, buyAmount); // actual-transferred accounting
    assert.equal(sellDec.value, sellAmount);
    await write(pool, "reveal", [1n, buyDec.decryptionProof, sellDec.decryptionProof]);

    // Netting: sell side ≈ 400 tUSDC < buy side 1000 → BuyHeavy, residual ≈ 600 tUSDC.
    await write(pool, "initiateSettlement", [1n]);
    epoch = await pool.read.getEpoch([1n]);
    assert.equal(epoch.state, 4); // UnwrapPending
    assert.equal(epoch.residual, 1); // BuyHeavy
    assert.ok(epoch.residualIn > 590n * USDC_DEC && epoch.residualIn < 610n * USDC_DEC);
    assert.ok(epoch.sellOutTotal > 390n * USDC_DEC && epoch.sellOutTotal < 410n * USDC_DEC);

    // Finalize: TEE-decrypt the unwrap request, swap residual on Uniswap, re-wrap output.
    const unwrapDec = await nox.publicDecrypt(epoch.unwrapRequestId as Hex);
    assert.equal(unwrapDec.value, epoch.residualIn);
    await write(pool, "finalizeSettlement", [1n, unwrapDec.decryptionProof]);
    epoch = await pool.read.getEpoch([1n]);
    assert.equal(epoch.state, 5); // Distributable
    // buyers get the crossed 0.2 WETH + swap output (~0.3 WETH minus fee/impact)
    assert.ok(epoch.buyOutTotal > sellAmount + (28n * WETH_DEC) / 100n);

    // Claim and verify decrypted confidential balances.
    await write(pool, "claim", [1n]);
    const cwethHandle = await cWETH.read.confidentialBalanceOf([user]);
    const cusdcHandle = await cUSDC.read.confidentialBalanceOf([user]);
    const cwethBal = (await nox.decrypt(cwethHandle as Hex)).value as bigint;
    const cusdcBal = (await nox.decrypt(cusdcHandle as Hex)).value as bigint;
    // wrapped 0.5, sold 0.2 → 0.3 remains, plus the full buy-side output
    assert.equal(cwethBal, WETH_DEC / 2n - sellAmount + (epoch.buyOutTotal as bigint));
    // wrapped 2000, deposited 1000 → 1000 remains, plus seller payout
    assert.equal(cusdcBal, 2_000n * USDC_DEC - buyAmount + (epoch.sellOutTotal as bigint));

    // Double-claim must revert.
    await assert.rejects(pool.write.claim([1n]));
  });

  it("cancelOrder refunds confidentially while the epoch is open", async () => {
    const epochId = await pool.read.currentEpochId();
    const before = await cUSDC.read.confidentialBalanceOf([user]);
    const beforeBal = (await nox.decrypt(before as Hex)).value as bigint;

    const enc = await nox.encryptInput(50n * USDC_DEC, "uint256", pool.address);
    await write(pool, "submitOrder", [true, enc.handle, enc.handleProof]);
    await write(pool, "cancelOrder", [true]);

    const after = await cUSDC.read.confidentialBalanceOf([user]);
    const afterBal = (await nox.decrypt(after as Hex)).value as bigint;
    assert.equal(afterBal, beforeBal);

    const epoch = await pool.read.getEpoch([epochId]);
    assert.equal(epoch.buyCount, 0);
  });

  it("rejects settlement cranks in the wrong state", async () => {
    const epochId = await pool.read.currentEpochId();
    await assert.rejects(pool.write.reveal([epochId, "0x", "0x"])); // not sealed
    await assert.rejects(pool.write.initiateSettlement([epochId])); // not revealed
    await assert.rejects(pool.write.seal()); // window not elapsed
  });
});
