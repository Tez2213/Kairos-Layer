/**
 * Idempotent Sepolia deployment for Kairos Layer.
 *
 * Deploys (skipping anything already recorded in deployments.json):
 *   1. TestUSDC (public quote token, faucet) + TestWETH (public base token, faucet)
 *   2. cUSDC + cWETH confidential wrappers (KairosWrappedToken)
 *   3. Uniswap V3 pool tUSDC/tWETH 0.3% on the CANONICAL Sepolia factory — created,
 *      initialized, seeded with deep liquidity, and primed with oracle observations
 *   4. KairosPool
 *
 * Usage:
 *   npx hardhat run scripts/deploy-sepolia.ts --network sepolia
 * Requires SEPOLIA_RPC_URL and SEPOLIA_PRIVATE_KEY (.env or hardhat keystore).
 *
 * WHY TestWETH INSTEAD OF CANONICAL WETH9: the residual swap enforces a slippage
 * floor, which caps the tradable residual at ~2.8% of pool depth. Seeding against
 * canonical WETH9 would need >10 real Sepolia ETH to support demo-sized orders;
 * faucet-minted tWETH lets us seed 100 tWETH / 200k tUSDC, matching the tested
 * configuration and giving ~5,500 tUSDC of headroom per residual. The Uniswap pool,
 * factory and swap path are entirely real either way.
 *
 * deployments.json is the single source of addresses consumed by frontend & keeper.
 */
import { network } from "hardhat";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";

// Canonical Sepolia infrastructure (verified live, July 2026).
const UNISWAP_V3_FACTORY: Address = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c";
const FEE = 3000;
const MIN_TICK = -887220; // multiple of tickSpacing 60
const MAX_TICK = 887220;

// Pool parameters
const EPOCH_DURATION = 600n; // 10 min epochs
const REVEAL_TIMEOUT = 3600n; // 1h before a sealed epoch can be cancelled
const UNWRAP_TIMEOUT = 900n; // 15 min before a pending unwrap can be recovered
const MAX_SLIPPAGE_BPS = 300; // 3%
const MIN_ORDERS = 2; // k-anonymity floor per side (1 would disable privacy)
const TWAP_WINDOW = 120; // seconds of TWAP for the manipulation guard
const MAX_TICK_DEVIATION = 200; // ~2% allowed spot-vs-TWAP deviation

// Seed liquidity — mirrors the integration test so tested behaviour == deployed.
const PRICE_USDC_PER_WETH = 2000n;
const SEED_WETH = 100n * 10n ** 18n;
const SEED_USDC = 200_000n * 10n ** 6n;
const PRIME_SWAP_USDC = 1n * 10n ** 6n; // 1 tUSDC, twice, to write oracle observations

const DEPLOYMENTS_FILE = new URL("../deployments.json", import.meta.url).pathname;

const factoryAbi = [
  {
    type: "function",
    name: "createPool",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getPool",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
    stateMutability: "view",
  },
] as const;

const uniPoolAbi = [
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
  {
    type: "function",
    name: "initialize",
    inputs: [{ name: "sqrtPriceX96", type: "uint160" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "liquidity",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "increaseObservationCardinalityNext",
    inputs: [{ name: "observationCardinalityNext", type: "uint16" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

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

function encodeSqrtPriceX96(num: bigint, den: bigint): bigint {
  return isqrt((num * (1n << 192n)) / den);
}

type Deployments = Record<string, string>;

function loadDeployments(): Deployments {
  if (!existsSync(DEPLOYMENTS_FILE)) return {};
  return JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
}

function saveDeployments(d: Deployments) {
  writeFileSync(DEPLOYMENTS_FILE, `${JSON.stringify(d, null, 2)}\n`);
}

async function main() {
  const connection = await network.connect({ network: "sepolia" });
  const { viem } = connection as any;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const me: Address = wallet.account.address;

  const chainId = await publicClient.getChainId();
  if (chainId !== 11155111) {
    throw new Error(`Expected Sepolia (11155111), got chainId ${chainId}`);
  }
  const balance = await publicClient.getBalance({ address: me });
  console.log(`Deployer: ${me}`);
  console.log(`Balance:  ${Number(balance) / 1e18} ETH`);
  // Measured cost of a full run: ~16.4M gas (~0.018 ETH at 1.1 gwei). The floor
  // leaves headroom for gas-price drift; the script is idempotent, so a run that
  // stops early can simply be re-run after topping up.
  if (balance < 2n * 10n ** 16n) {
    throw new Error(
      `Deployer has ${Number(balance) / 1e18} ETH; a full deploy needs ~0.02 Sepolia ETH.`,
    );
  }

  const deployments = loadDeployments();
  deployments.chainId = String(chainId);
  deployments.UniswapV3Factory = UNISWAP_V3_FACTORY;

  const waitFor = async (hash: Hex) =>
    publicClient.waitForTransactionReceipt({ hash });

  async function deployOnce(key: string, contractName: string, args: unknown[] = []) {
    const existing = deployments[key];
    if (existing) {
      console.log(`${key}: reusing ${existing}`);
      return existing as Address;
    }
    const contract = await viem.deployContract(contractName, args);
    deployments[key] = contract.address;
    saveDeployments(deployments);
    console.log(`${key}: deployed at ${contract.address}`);
    return contract.address as Address;
  }

  // 1. Public tokens
  const usdc = await deployOnce("TestUSDC", "TestUSDC");
  const weth = await deployOnce("TestWETH", "TestWETH");

  // 2. Confidential wrappers
  const cUSDC = await deployOnce("cUSDC", "KairosWrappedToken", [
    "Confidential tUSDC",
    "cUSDC",
    "",
    usdc,
  ]);
  const cWETH = await deployOnce("cWETH", "KairosWrappedToken", [
    "Confidential tWETH",
    "cWETH",
    "",
    weth,
  ]);

  // 3. Uniswap V3 pool on the canonical factory
  let uniPool = (await publicClient.readContract({
    address: UNISWAP_V3_FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [usdc, weth, FEE],
  })) as Address;

  if (uniPool === "0x0000000000000000000000000000000000000000") {
    console.log("Creating Uniswap V3 pool tUSDC/tWETH 0.3%…");
    await waitFor(
      await wallet.writeContract({
        address: UNISWAP_V3_FACTORY,
        abi: factoryAbi,
        functionName: "createPool",
        args: [usdc, weth, FEE],
      }),
    );
    uniPool = (await publicClient.readContract({
      address: UNISWAP_V3_FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [usdc, weth, FEE],
    })) as Address;
  }
  deployments.UniswapV3Pool = uniPool;
  saveDeployments(deployments);
  console.log(`Uniswap pool: ${uniPool}`);

  const usdcIsToken0 = usdc.toLowerCase() < weth.toLowerCase();

  // Initialize price if needed
  let slot0 = (await publicClient.readContract({
    address: uniPool,
    abi: uniPoolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, number, number, number, number, boolean];
  if (slot0[0] === 0n) {
    const sqrtPriceX96 = usdcIsToken0
      ? encodeSqrtPriceX96(10n ** 18n, PRICE_USDC_PER_WETH * 10n ** 6n)
      : encodeSqrtPriceX96(PRICE_USDC_PER_WETH * 10n ** 6n, 10n ** 18n);
    console.log("Initializing pool price (1 tWETH = 2000 tUSDC)…");
    await waitFor(
      await wallet.writeContract({
        address: uniPool,
        abi: uniPoolAbi,
        functionName: "initialize",
        args: [sqrtPriceX96],
      }),
    );
  }

  // Oracle capacity for the TWAP manipulation guard (idempotent: only grows).
  slot0 = (await publicClient.readContract({
    address: uniPool,
    abi: uniPoolAbi,
    functionName: "slot0",
  })) as typeof slot0;
  if (slot0[4] < 10) {
    console.log("Increasing oracle observation cardinality to 10…");
    await waitFor(
      await wallet.writeContract({
        address: uniPool,
        abi: uniPoolAbi,
        functionName: "increaseObservationCardinalityNext",
        args: [10],
      }),
    );
  }

  // Seed liquidity if the pool is empty
  const seeder = await deployOnce("UniswapSeeder", "UniswapSeeder");
  const seederContract = await viem.getContractAt("UniswapSeeder", seeder);
  const usdcContract = await viem.getContractAt("TestUSDC", usdc);
  const wethContract = await viem.getContractAt("TestWETH", weth);

  const liquidity = (await publicClient.readContract({
    address: uniPool,
    abi: uniPoolAbi,
    functionName: "liquidity",
  })) as bigint;

  if (liquidity === 0n) {
    console.log("Seeding pool liquidity (200,000 tUSDC / 100 tWETH)…");
    // Fund with 1% headroom: the exact mint amounts depend on price rounding.
    const usdcFund = (SEED_USDC * 101n) / 100n + PRIME_SWAP_USDC * 4n;
    const wethFund = (SEED_WETH * 101n) / 100n;
    await waitFor(await usdcContract.write.faucet([usdcFund]));
    await waitFor(await wethContract.write.faucet([wethFund]));
    await waitFor(await usdcContract.write.transfer([seeder, usdcFund]));
    await waitFor(await wethContract.write.transfer([seeder, wethFund]));

    const L = isqrt(SEED_USDC * SEED_WETH);
    await waitFor(await seederContract.write.seed([uniPool, MIN_TICK, MAX_TICK, L]));
    console.log("Liquidity seeded.");

    // Prime the oracle: each swap in a distinct block writes an observation, which
    // KairosPool's TWAP guard needs. Without history, observe() reverts.
    console.log("Priming oracle observations…");
    await waitFor(
      await seederContract.write.prime([uniPool, usdcIsToken0, PRIME_SWAP_USDC]),
    );
    await waitFor(
      await seederContract.write.prime([uniPool, usdcIsToken0, PRIME_SWAP_USDC]),
    );

    // Return leftovers so nothing is stranded in the helper.
    await waitFor(await seederContract.write.rescue([usdc, me]));
    await waitFor(await seederContract.write.rescue([weth, me]));
  } else {
    console.log(`Pool already has liquidity: ${liquidity}`);
  }

  // 4. The dark pool itself
  const kairosPool = await deployOnce("KairosPool", "KairosPool", [
    cUSDC,
    cWETH,
    uniPool,
    EPOCH_DURATION,
    REVEAL_TIMEOUT,
    UNWRAP_TIMEOUT,
    MAX_SLIPPAGE_BPS,
    MIN_ORDERS,
    me,
  ]);

  // Enable the price-manipulation guard now that the oracle has history.
  const pool = await viem.getContractAt("KairosPool", kairosPool);
  const currentWindow = await pool.read.twapWindow();
  if (Number(currentWindow) !== TWAP_WINDOW) {
    console.log(`Enabling TWAP price guard (${TWAP_WINDOW}s / ${MAX_TICK_DEVIATION} ticks)…`);
    await waitFor(await pool.write.setPriceGuard([TWAP_WINDOW, MAX_TICK_DEVIATION]));
  }

  saveDeployments(deployments);
  console.log("\nAll deployments:");
  console.log(JSON.stringify(deployments, null, 2));
  console.log(
    "\nVerify with:\n" +
      `  npx hardhat verify --network sepolia ${usdc}\n` +
      `  npx hardhat verify --network sepolia ${weth}\n` +
      `  npx hardhat verify --network sepolia ${cUSDC} "Confidential tUSDC" "cUSDC" "" ${usdc}\n` +
      `  npx hardhat verify --network sepolia ${cWETH} "Confidential tWETH" "cWETH" "" ${weth}\n` +
      `  npx hardhat verify --network sepolia ${kairosPool} ${cUSDC} ${cWETH} ${uniPool} ` +
      `${EPOCH_DURATION} ${REVEAL_TIMEOUT} ${UNWRAP_TIMEOUT} ${MAX_SLIPPAGE_BPS} ${MIN_ORDERS} ${me}`,
  );
}

await main();
