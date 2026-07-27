/**
 * Kairos Layer — full end-to-end run against REAL Ethereum Sepolia.
 *
 * Proves the complete confidential flow with no mocks and no local stack:
 *   fund → faucet → wrap → setOperator → 4 encrypted orders (2 buy / 2 sell)
 *   → seal → reveal (real TEE proofs) → net → residual swap on real Uniswap V3
 *   → pro-rata claims → each user decrypts ONLY their own balance.
 *
 * This is also the demo-video rehearsal script.
 *
 * Usage:  node scripts/e2e-sepolia.mjs
 * Reads deployments.json + .env (SEPOLIA_RPC_URL, SEPOLIA_PRIVATE_KEY).
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";

// ---------- config ----------

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const RPC = env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const D = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"));

const abiOf = (p) =>
  JSON.parse(readFileSync(new URL(`../artifacts/${p}`, import.meta.url), "utf8")).abi;
const POOL_ABI = abiOf("contracts/KairosPool.sol/KairosPool.json");
const TOKEN_ABI = abiOf("contracts/tokens/TestUSDC.sol/TestUSDC.json");
const CTOKEN_ABI = abiOf("contracts/tokens/KairosWrappedToken.sol/KairosWrappedToken.json");

const USDC = 10n ** 6n;
const WETH = 10n ** 18n;

// Deterministic burner wallets for the demo (testnet only — derived from a public label).
const NUM_USERS = 4;
const userKeys = Array.from({ length: NUM_USERS }, (_, i) =>
  keccak256(toHex(`kairos-layer-e2e-user-${i}`)),
);
const userAccounts = userKeys.map((k) => privateKeyToAccount(k));

// Orders: two buyers (quote in) and two sellers (base in).
const ORDERS = [
  { user: 0, isBuy: true, amount: 1_000n * USDC, label: "buy 1,000 tUSDC" },
  { user: 1, isBuy: true, amount: 500n * USDC, label: "buy 500 tUSDC" },
  { user: 2, isBuy: false, amount: WETH / 5n, label: "sell 0.2 tWETH" },
  { user: 3, isBuy: false, amount: WETH / 10n, label: "sell 0.1 tWETH" },
];

const GAS_PER_USER = 6_000_000_000_000_000n; // 0.006 ETH
const WRAP_USDC = 3_000n * USDC;
const WRAP_WETH = WETH / 2n;
/**
 * 3 minutes. A 60s window is NOT enough on real Sepolia: orders are rejected at
 * `block.timestamp >= endTime`, and each order costs a gateway round-trip plus a
 * ~12s block. Orders are also pre-encrypted and submitted concurrently below.
 */
const EPOCH_DURATION = 180n;

// ---------- clients ----------

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const deployer = privateKeyToAccount(
  env.SEPOLIA_PRIVATE_KEY.startsWith("0x")
    ? env.SEPOLIA_PRIVATE_KEY
    : `0x${env.SEPOLIA_PRIVATE_KEY}`,
);
const wallet = (account) => createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const deployerW = wallet(deployer);
const userW = userAccounts.map(wallet);
const handleClients = new Map();
const handleClientFor = async (i) => {
  if (!handleClients.has(i)) handleClients.set(i, await createViemHandleClient(userW[i]));
  return handleClients.get(i);
};

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const log = (msg) => console.log(`${msg}`);
const phase = (msg) => console.log(`\n[${++step}] ${msg}`);

async function send(w, params, label) {
  const hash = await w.writeContract(params);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  return rcpt;
}

async function retry(fn, label, attempts = 60, delayMs = 5000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === 0) log(`    waiting on ${label} (TEE round-trip)…`);
      await sleep(delayMs);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr?.shortMessage || lastErr?.message}`);
}

const readPool = (fn, args = []) =>
  pub.readContract({ address: D.KairosPool, abi: POOL_ABI, functionName: fn, args });

async function confBalance(cToken, i) {
  const handle = await pub.readContract({
    address: cToken,
    abi: CTOKEN_ABI,
    functionName: "confidentialBalanceOf",
    args: [userAccounts[i].address],
  });
  if (handle === `0x${"0".repeat(64)}`) return 0n;
  const client = await handleClientFor(i);
  return retry(async () => (await client.decrypt(handle)).value, `decrypt balance u${i}`, 40, 4000);
}

const fmt = (v, dec) => (Number(v) / Number(dec)).toLocaleString(undefined, { maximumFractionDigits: 6 });

const ZERO32 = `0x${"0".repeat(64)}`;

/** Drive an epoch from wherever it is to Distributable (or Cancelled). */
async function driveSettlement(id, verbose = true) {
  const say = (m) => verbose && log(m);
  let e = await readPool("getEpoch", [id]);

  if (e.state === 1) {
    const now = Number((await pub.getBlock()).timestamp);
    const wait = Number(e.endTime) - now + 5;
    if (wait > 0) {
      say(`    waiting ${wait}s for the epoch window to close…`);
      await sleep(wait * 1000);
    }
    await send(deployerW, { address: D.KairosPool, abi: POOL_ABI, functionName: "seal" }, "seal");
    e = await readPool("getEpoch", [id]);
    say(`    sealed: ${e.buyCount} buyers / ${e.sellCount} sellers`);
  }
  if (e.state === 6) return e; // cancelled (e.g. privacy floor not met)

  if (e.state === 2) {
    const client = await handleClientFor(0);
    const buyProof =
      e.buyCount > 0
        ? (await retry(() => client.publicDecrypt(e.buyTotalEnc), "publicDecrypt buyTotal"))
            .decryptionProof
        : "0x";
    const sellProof =
      e.sellCount > 0
        ? (await retry(() => client.publicDecrypt(e.sellTotalEnc), "publicDecrypt sellTotal"))
            .decryptionProof
        : "0x";
    await send(
      deployerW,
      {
        address: D.KairosPool,
        abi: POOL_ABI,
        functionName: "reveal",
        args: [id, buyProof, sellProof],
      },
      "reveal",
    );
    e = await readPool("getEpoch", [id]);
    say(`    revealed: buyTotal ${fmt(e.buyTotal, USDC)} tUSDC / sellTotal ${fmt(e.sellTotal, WETH)} tWETH`);
  }
  if (e.state === 3) {
    await send(
      deployerW,
      { address: D.KairosPool, abi: POOL_ABI, functionName: "initiateSettlement", args: [id] },
      "initiateSettlement",
    );
    e = await readPool("getEpoch", [id]);
    const RES = ["NoResidual", "BuyHeavy", "SellHeavy"][e.residual];
    say(`    netted → residual ${RES} ${e.residual === 1 ? fmt(e.residualIn, USDC) + " tUSDC" : e.residual === 2 ? fmt(e.residualIn, WETH) + " tWETH" : "(none)"}`);
  }
  if (e.state === 4) {
    const client = await handleClientFor(0);
    const unwrapDec = await retry(
      () => client.publicDecrypt(e.unwrapRequestId),
      "publicDecrypt unwrapRequest",
    );
    await send(
      deployerW,
      {
        address: D.KairosPool,
        abi: POOL_ABI,
        functionName: "finalizeSettlement",
        args: [id, unwrapDec.decryptionProof, 0n],
      },
      "finalizeSettlement",
    );
    e = await readPool("getEpoch", [id]);
    say(`    residual swapped on Uniswap → Distributable`);
  }
  return e;
}

/** Claim (or refund) for every user holding a position in the epoch. */
async function claimAll(id, e) {
  const fn = e.state === 6 ? "claimRefund" : "claim";
  for (let i = 0; i < NUM_USERS; i++) {
    const [b, s] = await Promise.all([
      readPool("orderOf", [id, userAccounts[i].address, true]),
      readPool("orderOf", [id, userAccounts[i].address, false]),
    ]);
    if (b === ZERO32 && s === ZERO32) continue;
    if (await readPool("claimed", [id, userAccounts[i].address])) continue;
    await send(
      userW[i],
      { address: D.KairosPool, abi: POOL_ABI, functionName: fn, args: [id] },
      fn,
    );
    log(`    u${i} ${fn} ok`);
  }
}

// ---------- run ----------

console.log("=".repeat(70));
console.log("KAIROS LAYER — END-TO-END ON ETHEREUM SEPOLIA (no mocks)");
console.log("=".repeat(70));
console.log(`KairosPool : ${D.KairosPool}`);
console.log(`Uniswap V3 : ${D.UniswapV3Pool}`);
console.log(`Deployer   : ${deployer.address}`);

phase("Funding demo wallets with gas");
for (let i = 0; i < NUM_USERS; i++) {
  const bal = await pub.getBalance({ address: userAccounts[i].address });
  if (bal < GAS_PER_USER / 2n) {
    const hash = await deployerW.sendTransaction({
      to: userAccounts[i].address,
      value: GAS_PER_USER,
    });
    await pub.waitForTransactionReceipt({ hash });
    log(`    u${i} ${userAccounts[i].address} funded ${formatEther(GAS_PER_USER)} ETH`);
  } else {
    log(`    u${i} ${userAccounts[i].address} already has ${formatEther(bal)} ETH`);
  }
}

phase("Minting test tokens and wrapping into confidential form");
for (let i = 0; i < NUM_USERS; i++) {
  const isBuyer = ORDERS.find((o) => o.user === i).isBuy;
  const token = isBuyer ? D.TestUSDC : D.TestWETH;
  const cToken = isBuyer ? D.cUSDC : D.cWETH;
  const amount = isBuyer ? WRAP_USDC : WRAP_WETH;

  const held = await pub.readContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [userAccounts[i].address],
  });
  if (held < amount) {
    await send(
      userW[i],
      { address: token, abi: TOKEN_ABI, functionName: "faucet", args: [amount * 2n] },
      "faucet",
    );
  }
  await send(
    userW[i],
    { address: token, abi: TOKEN_ABI, functionName: "approve", args: [cToken, amount] },
    "approve",
  );
  await send(
    userW[i],
    {
      address: cToken,
      abi: CTOKEN_ABI,
      functionName: "wrap",
      args: [userAccounts[i].address, amount],
    },
    "wrap",
  );
  const until = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
  await send(
    userW[i],
    { address: cToken, abi: CTOKEN_ABI, functionName: "setOperator", args: [D.KairosPool, until] },
    "setOperator",
  );
  log(
    `    u${i} wrapped ${isBuyer ? fmt(amount, USDC) + " tUSDC → cUSDC" : fmt(amount, WETH) + " tWETH → cWETH"}, pool authorised`,
  );
}

phase(`Setting epoch duration to ${EPOCH_DURATION}s and rolling to a fresh epoch`);
const curDuration = await readPool("epochDuration");
if (curDuration !== EPOCH_DURATION) {
  const [, revealTo, unwrapTo, slip, minOrd] = await Promise.all([
    readPool("epochDuration"),
    readPool("revealTimeout"),
    readPool("unwrapTimeout"),
    readPool("maxSlippageBps"),
    readPool("minOrders"),
  ]);
  await send(
    deployerW,
    {
      address: D.KairosPool,
      abi: POOL_ABI,
      functionName: "setEpochParams",
      args: [EPOCH_DURATION, revealTo, unwrapTo, slip, minOrd],
    },
    "setEpochParams",
  );
  log(`    epochDuration ${curDuration}s → ${EPOCH_DURATION}s`);
}
// Drain any stale epoch (e.g. from an interrupted run) so users' funds are freed
// and the clean run starts from a fresh window.
let epochId = await readPool("currentEpochId");
let epoch = await readPool("getEpoch", [epochId]);
let now = Number((await pub.getBlock()).timestamp);
if (epoch.state === 1 && now >= Number(epoch.endTime)) {
  const hasOrders = epoch.buyCount > 0 || epoch.sellCount > 0;
  if (hasOrders) {
    log(`    stale epoch ${epochId} holds ${epoch.buyCount} buy / ${epoch.sellCount} sell orders — settling it first`);
    const settled = await driveSettlement(epochId);
    await claimAll(epochId, settled);
  } else {
    await send(deployerW, { address: D.KairosPool, abi: POOL_ABI, functionName: "seal" }, "seal");
  }
  epochId = await readPool("currentEpochId");
  epoch = await readPool("getEpoch", [epochId]);
  now = Number((await pub.getBlock()).timestamp);
  log(`    rolled forward → epoch ${epochId}`);
}
log(`    epoch ${epochId} open, ends in ${Number(epoch.endTime) - now}s`);

phase("Encrypting 4 orders client-side (plaintext never leaves the browser/script)");
const encrypted = await Promise.all(
  ORDERS.map(async (o) => {
    const client = await handleClientFor(o.user);
    const enc = await retry(
      () => client.encryptInput(o.amount, "uint256", D.KairosPool),
      `encryptInput u${o.user}`,
      20,
      3000,
    );
    log(`    u${o.user} ${o.label.padEnd(16)} → handle ${enc.handle.slice(0, 18)}… (amount hidden)`);
    return { ...o, ...enc };
  }),
);

phase("Submitting all 4 encrypted orders CONCURRENTLY (must land before endTime)");
epoch = await readPool("getEpoch", [epochId]);
now = Number((await pub.getBlock()).timestamp);
log(`    ${Number(epoch.endTime) - now}s of window left`);
await Promise.all(
  encrypted.map((o) =>
    send(
      userW[o.user],
      {
        address: D.KairosPool,
        abi: POOL_ABI,
        functionName: "submitOrder",
        args: [o.isBuy, o.handle, o.handleProof],
      },
      `submitOrder u${o.user}`,
    ),
  ),
);
epoch = await readPool("getEpoch", [epochId]);
log(`    all landed: buyCount ${epoch.buyCount}, sellCount ${epoch.sellCount}`);
if (epoch.buyCount < 2 || epoch.sellCount < 2) {
  throw new Error("orders did not all land — privacy floor would cancel this epoch");
}

phase("Sealing → revealing aggregates (real TEE proofs verified on-chain) → netting");
const poolUsdcBefore = await pub.readContract({
  address: D.TestUSDC,
  abi: TOKEN_ABI,
  functionName: "balanceOf",
  args: [D.UniswapV3Pool],
});
epoch = await driveSettlement(epochId);
if (epoch.state !== 5) throw new Error(`expected Distributable, got state ${epoch.state}`);
const poolUsdcAfter = await pub.readContract({
  address: D.TestUSDC,
  abi: TOKEN_ABI,
  functionName: "balanceOf",
  args: [D.UniswapV3Pool],
});
log(`    Uniswap received exactly ${fmt(poolUsdcAfter - poolUsdcBefore, USDC)} tUSDC — the residual only`);
log(`    matched internally (never hit the chain): ${fmt(epoch.sellOutTotal, USDC)} tUSDC of sell-side`);
log(`    buyOutTotal  = ${fmt(epoch.buyOutTotal, WETH)} tWETH to split among buyers`);
log(`    sellOutTotal = ${fmt(epoch.sellOutTotal, USDC)} tUSDC to split among sellers`);

phase("Claiming pro-rata payouts (ratios computed on ENCRYPTED values in the TEE)");
const results = [];
for (const o of ORDERS) {
  const cOut = o.isBuy ? D.cWETH : D.cUSDC;
  const before = await confBalance(cOut, o.user);
  await send(
    userW[o.user],
    { address: D.KairosPool, abi: POOL_ABI, functionName: "claim", args: [epochId] },
    "claim",
  );
  const after = await confBalance(cOut, o.user);
  const received = after - before;
  const expected = o.isBuy
    ? (o.amount * epoch.buyOutTotal) / epoch.buyTotal
    : (o.amount * epoch.sellOutTotal) / epoch.sellTotal;
  const ok = received === expected;
  results.push({ ...o, received, expected, ok });
  log(
    `    u${o.user} ${o.label.padEnd(16)} → received ${o.isBuy ? fmt(received, WETH) + " cWETH" : fmt(received, USDC) + " cUSDC"} ${ok ? "✓ matches pro-rata" : `✗ expected ${expected}`}`,
  );
}

phase("Privacy check: a stranger must NOT be able to decrypt someone else's order");
const victimHandle = await readPool("orderOf", [epochId, userAccounts[0].address, true]);
const strangerClient = await handleClientFor(2);
let denied = false;
try {
  await strangerClient.decrypt(victimHandle);
} catch {
  denied = true;
}
log(`    u2 attempting to decrypt u0's order handle → ${denied ? "DENIED ✓ (ACL enforced)" : "DECRYPTED ✗ PRIVACY BREACH"}`);
const ownValue = await retry(
  async () => (await (await handleClientFor(0)).decrypt(victimHandle)).value,
  "owner decrypt",
  20,
  3000,
);
log(`    u0 decrypting their own order        → ${fmt(ownValue, USDC)} tUSDC ✓`);

console.log(`\n${"=".repeat(70)}`);
const allOk = results.every((r) => r.ok) && denied && ownValue === ORDERS[0].amount;
console.log(allOk ? "END-TO-END RUN PASSED ✅" : "END-TO-END RUN HAD FAILURES ❌");
console.log("=".repeat(70));
console.log(`Epoch ${epochId} on https://sepolia.etherscan.io/address/${D.KairosPool}#events`);
const left = await pub.getBalance({ address: deployer.address });
console.log(`Deployer gas left: ${formatEther(left)} ETH`);
if (!allOk) process.exit(1);
