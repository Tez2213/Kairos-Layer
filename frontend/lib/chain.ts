import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { DEPLOYMENTS } from "./generated";

export const RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

export const CHAIN = sepolia;

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
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
