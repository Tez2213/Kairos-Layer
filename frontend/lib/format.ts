/** Formatting helpers — every number in this app is a bigint of raw base units. */

export function fmtUnits(value: bigint, decimals: number, maxFrac = 6): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  return `${neg ? "-" : ""}${wholeStr}${fracStr ? `.${fracStr}` : ""}`;
}

export function parseUnits(input: string, decimals: number): bigint {
  const cleaned = input.trim().replace(/,/g, "");
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) return 0n;
  const [w = "0", f = ""] = cleaned.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export const short = (addr?: string, size = 4) =>
  addr ? `${addr.slice(0, 2 + size)}…${addr.slice(-size)}` : "—";

export const shortHandle = (h?: string) =>
  !h || h === `0x${"0".repeat(64)}` ? "—" : `${h.slice(0, 10)}…${h.slice(-6)}`;

export function countdown(seconds: number): string {
  if (seconds <= 0) return "closed";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function ago(ts: number): string {
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** Human-readable reason from a contract revert, without the viem noise. */
export function revertReason(err: unknown): string {
  const msg =
    (err as { shortMessage?: string })?.shortMessage ??
    (err as Error)?.message ??
    String(err);
  const custom = msg.match(/Kairos_[A-Za-z]+/)?.[0];
  if (custom) {
    const map: Record<string, string> = {
      Kairos_EpochEnded: "The epoch window has already closed — wait for the next one.",
      Kairos_EpochNotEnded: "The epoch is still accepting orders.",
      Kairos_WrongState: "The epoch is not in the right state for that action.",
      Kairos_NoOrder: "You have no position in this epoch.",
      Kairos_AlreadyClaimed: "You have already claimed this epoch.",
      Kairos_TimeoutNotReached: "The safety timeout has not elapsed yet.",
      Kairos_ZeroPayout: "Refused: that would settle a funded side to zero.",
      Kairos_SlippageExceeded: "The swap would exceed the slippage bound.",
      Kairos_PriceDeviation: "Pool price is too far from its TWAP — settlement is paused.",
      Kairos_InsufficientEscrow: "Escrow accounting check failed.",
      Kairos_UnwrapNotFinalized: "The TEE has not released the residual yet.",
    };
    return map[custom] ?? custom.replace("Kairos_", "");
  }
  if (/User rejected|denied transaction/i.test(msg)) return "You rejected the transaction.";
  if (/insufficient funds/i.test(msg)) return "Not enough Sepolia ETH for gas.";
  return msg.split("\n")[0].slice(0, 200);
}
