import { createPublicClient, fallback, http } from "viem";
import { sepolia } from "viem/chains";
import { DEPLOYMENTS } from "./generated";

export const CHAIN = sepolia;

/** Public Sepolia endpoints, all verified to send permissive CORS headers. */
const PUBLIC_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://1rpc.io/sepolia",
];

const isBrowser = typeof window !== "undefined";

/**
 * Read endpoints, in priority order:
 *   1. NEXT_PUBLIC_SEPOLIA_RPC_URL — a dedicated endpoint, if you set one.
 *      NOTE: anything NEXT_PUBLIC_ is visible in the browser bundle, so only
 *      put a domain-restricted key here.
 *   2. /api/rpc — same-origin proxy that reads the SERVER-side SEPOLIA_RPC_URL,
 *      which keeps a private key out of the client entirely.
 *   3. Public endpoints, as redundancy.
 *
 * viem's fallback transport retries the next endpoint on failure, so a single
 * rate-limited provider cannot take the app down.
 */
const RPC_URLS = [
  ...(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ? [process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL] : []),
  ...(isBrowser ? ["/api/rpc"] : []),
  ...PUBLIC_RPCS,
];

export const RPC_URL = RPC_URLS[0];

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: fallback(
    RPC_URLS.map((url) => http(url, { timeout: 15_000, retryCount: 1 })),
    { rank: false },
  ),
  /**
   * Collapse the many small reads each page makes into single Multicall3
   * requests (Sepolia: 0xcA11…CA11). Without this the overview page alone issues
   * ~19 requests per refresh, which is enough to get rate-limited on a free
   * public endpoint once a few people are watching at once.
   */
  batch: { multicall: { wait: 40, batchSize: 2048 } },
});

export const A = {
  pool: DEPLOYMENTS.KairosPool as `0x${string}`,
  cUSDC: DEPLOYMENTS.cUSDC as `0x${string}`,
  cWETH: DEPLOYMENTS.cWETH as `0x${string}`,
  usdc: DEPLOYMENTS.TestUSDC as `0x${string}`,
  weth: DEPLOYMENTS.TestWETH as `0x${string}`,
  uniPool: DEPLOYMENTS.UniswapV3Pool as `0x${string}`,
  factory: DEPLOYMENTS.UniswapV3Factory as `0x${string}`,
  noxCompute: "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF" as `0x${string}`,
};

export const scan = (addr: string, kind: "address" | "tx" = "address") =>
  `https://sepolia.etherscan.io/${kind}/${addr}`;

export const QUOTE = { symbol: "tUSDC", cSymbol: "cUSDC", decimals: 6 } as const;
export const BASE = { symbol: "tWETH", cSymbol: "cWETH", decimals: 18 } as const;

/** Epoch lifecycle states, mirroring KairosPool.EpochState. */
export const EPOCH_STATES = [
  "None",
  "Open",
  "Sealed",
  "Revealed",
  "UnwrapPending",
  "Distributable",
  "Cancelled",
] as const;
export type EpochState = (typeof EPOCH_STATES)[number];

/** Display names — `UnwrapPending` uppercases badly as one word. */
export const EPOCH_LABELS: Record<EpochState, string> = {
  None: "None",
  Open: "Open",
  Sealed: "Sealed",
  Revealed: "Revealed",
  UnwrapPending: "Unwrap pending",
  Distributable: "Settled",
  Cancelled: "Cancelled",
};

export const labelFor = (state: number) => EPOCH_LABELS[EPOCH_STATES[state] ?? "None"];

export const RESIDUAL_KINDS = ["No residual", "Buy-heavy", "Sell-heavy"] as const;

/** One-line description of what each state means, for the UI. */
export const STATE_COPY: Record<EpochState, string> = {
  None: "Does not exist yet.",
  Open: "Accepting encrypted orders. Nothing is revealed.",
  Sealed: "Closed to orders. Only the two side totals are now publicly decryptable.",
  Revealed: "Side totals proved on-chain. Ready to net.",
  UnwrapPending: "Residual is being released by the TEE before it can be swapped.",
  Distributable: "Settled. Everyone can claim their pro-rata share.",
  Cancelled: "Not settled — every deposit is refundable in full.",
};
