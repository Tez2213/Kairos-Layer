/**
 * Idempotent Sepolia deployment for Kairos Layer.
 *
 * Deploys (skipping anything already recorded in deployments.json):
 *   1. TestUSDC (public quote token, open faucet)
 *   2. cUSDC + cWETH confidential wrappers (KairosWrappedToken)
 *   3. Uniswap V3 pool tUSDC/WETH9 0.3% on the CANONICAL Sepolia factory (created
 *      + initialized + seeded only if missing/empty)
 *   4. KairosPool
 *
 * Usage:
 *   npx hardhat run scripts/deploy-sepolia.ts --network sepolia
 * Requires config variables SEPOLIA_RPC_URL and SEPOLIA_PRIVATE_KEY.
 *
 * deployments.json is the single source of addresses consumed by frontend & keeper.
 */
import { network } from "hardhat";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";

// Canonical Sepolia addresses (verified against Uniswap deployment docs, July 2026).
const UNISWAP_V3_FACTORY: Address = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c";
const WETH9: Address = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14";
const FEE = 3000;
const MIN_TICK = -887220;
const MAX_TICK = 887220;

// Pool parameters
const EPOCH_DURATION = 600n; // 10 min epochs for the demo
const REVEAL_TIMEOUT = 3600n; // 1h before cancel is possible
const MAX_SLIPPAGE_BPS = 300; // 3%

// Seed liquidity targets (WETH side is the constraint — testnet ETH is scarce)
const PRICE_USDC_PER_WETH = 2000n;
const SEED_WETH = 2n * 10n ** 17n; // 0.2 WETH
const SEED_USDC = (SEED_WETH * PRICE_USDC_PER_WETH) / 10n ** 12n; // matching tUSDC (6 dec)

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
] as const;

const weth9Abi = [
  {
    type: "function",
    name: "deposit",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
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

type Deployments = Record<string, Address>;

function loadDeployments(): Deployments {
  if (!existsSync(DEPLOYMENTS_FILE)) return {};
  return JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8"));
}

function saveDeployments(d: Deployments) {
  writeFileSync(DEPLOYMENTS_FILE, `${JSON.stringify(d, null, 2)}\n`);
  console.log("deployments.json updated");
}

async function main() {
  const connection = await network.connect({ network: "sepolia" });
  const { viem } = connection as any;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const me: Address = wallet.account.address;
  console.log(`Deployer: ${me}`);

  const deployments = loadDeployments();

  async function deployOnce(key: string, contractName: string, args: unknown[] = []) {
    if (deployments[key]) {
      console.log(`${key}: already deployed at ${deployments[key]}`);
      return deployments[key];
    }
    const contract = await viem.deployContract(contractName, args);
    deployments[key] = contract.address;
    saveDeployments(deployments);
    console.log(`${key}: deployed at ${contract.address}`);
    return contract.address as Address;
  }

  // 1. Public quote token
  const usdc = await deployOnce("TestUSDC", "TestUSDC");

  // 2. Confidential wrappers
  const cUSDC = await deployOnce("cUSDC", "KairosWrappedToken", [
    "Confidential tUSDC",
    "cUSDC",
    "",
    usdc,
  ]);
  const cWETH = await deployOnce("cWETH", "KairosWrappedToken", [
    "Confidential WETH",
    "cWETH",
    "",
    WETH9,
  ]);

  // 3. Uniswap V3 pool on the canonical factory
  let uniPool = (await publicClient.readContract({
    address: UNISWAP_V3_FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [usdc, WETH9, FEE],
  })) as Address;
  if (uniPool === "0x0000000000000000000000000000000000000000") {
    console.log("Creating Uniswap V3 pool tUSDC/WETH 0.3%…");
    const hash = await wallet.writeContract({
      address: UNISWAP_V3_FACTORY,
      abi: factoryAbi,
      functionName: "createPool",
      args: [usdc, WETH9, FEE],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    uniPool = (await publicClient.readContract({
      address: UNISWAP_V3_FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [usdc, WETH9, FEE],
    })) as Address;
  }
  deployments["UniswapV3Pool"] = uniPool;
  saveDeployments(deployments);
  console.log(`Uniswap pool: ${uniPool}`);

  // Initialize price if needed
  const slot0 = (await publicClient.readContract({
    address: uniPool,
    abi: uniPoolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, number, number, number, number, boolean];
  if (slot0[0] === 0n) {
    const usdcIsToken0 = usdc.toLowerCase() < WETH9.toLowerCase();
    const sqrtPriceX96 = usdcIsToken0
      ? encodeSqrtPriceX96(10n ** 18n, PRICE_USDC_PER_WETH * 10n ** 6n)
      : encodeSqrtPriceX96(PRICE_USDC_PER_WETH * 10n ** 6n, 10n ** 18n);
    console.log("Initializing pool price (1 WETH = 2000 tUSDC)…");
    const hash = await wallet.writeContract({
      address: uniPool,
      abi: uniPoolAbi,
      functionName: "initialize",
      args: [sqrtPriceX96],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  // Seed liquidity if the pool is empty
  const liquidity = (await publicClient.readContract({
    address: uniPool,
    abi: uniPoolAbi,
    functionName: "liquidity",
  })) as bigint;
  if (liquidity === 0n) {
    console.log("Seeding pool liquidity…");
    const seeder = await deployOnce("UniswapSeeder", "UniswapSeeder");
    const usdcContract = await viem.getContractAt("TestUSDC", usdc);

    let hash = await usdcContract.write.faucet([SEED_USDC]);
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await usdcContract.write.transfer([seeder, SEED_USDC]);
    await publicClient.waitForTransactionReceipt({ hash });

    console.log(`Wrapping ${SEED_WETH} wei ETH into WETH9…`);
    hash = await wallet.writeContract({
      address: WETH9,
      abi: weth9Abi,
      functionName: "deposit",
      value: SEED_WETH,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await wallet.writeContract({
      address: WETH9,
      abi: weth9Abi,
      functionName: "transfer",
      args: [seeder, SEED_WETH],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const seederContract = await viem.getContractAt("UniswapSeeder", seeder);
    const L = isqrt(SEED_USDC * SEED_WETH);
    hash = await seederContract.write.seed([uniPool, MIN_TICK, MAX_TICK, L]);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log("Liquidity seeded.");
  } else {
    console.log(`Pool already has liquidity: ${liquidity}`);
  }

  // 4. The dark pool itself
  await deployOnce("KairosPool", "KairosPool", [
    cUSDC,
    cWETH,
    uniPool,
    EPOCH_DURATION,
    REVEAL_TIMEOUT,
    MAX_SLIPPAGE_BPS,
    me,
  ]);

  console.log("\nAll deployments:");
  console.log(JSON.stringify(loadDeployments(), null, 2));
  console.log(
    "\nNext: verify on Etherscan, e.g.\n" +
      "  npx hardhat verify --network sepolia <KairosPool> <cUSDC> <cWETH> <uniPool> 600 3600 300 <owner>",
  );
}

await main();
