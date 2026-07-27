/**
 * Counterfactual analysis: what did netting actually save?
 *
 * The comparison is deliberately conservative. We ask: if every order in this
 * epoch had been sent to the same Uniswap pool individually — which is exactly
 * what these traders would otherwise have done — what would they have received?
 *
 * Full-range V3 liquidity behaves as constant product against the pool's token
 * balances, so a swap of `x` into reserves (Rin, Rout) with fee f returns
 *   out = (x·f·Rout) / (Rin + x·f)
 * That understates real V3 depth slightly when liquidity is concentrated, so
 * every number here is a floor, not a flattering estimate.
 */

import type { Epoch } from "./hooks";

const FEE_BPS = 3000n / 100n; // 0.3% pool → 30 bps
const BPS = 10_000n;

export type Reserves = { quote: bigint; base: bigint };

/** Constant-product output, fee included. */
export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const afterFee = (amountIn * (BPS - FEE_BPS)) / BPS;
  return (afterFee * reserveOut) / (reserveIn + afterFee);
}

/** Marginal (zero-size) price — the ideal fill with no fee and no impact. */
export function idealOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (reserveIn <= 0n) return 0n;
  return (amountIn * reserveOut) / reserveIn;
}

export type EpochSavings = {
  /** Volume matched internally, in quote units. Never reached the public market. */
  crossedQuote: bigint;
  /** Volume that did reach Uniswap, in quote units. */
  routedQuote: bigint;
  /** Share of epoch volume that never appeared on-chain, 0–1. */
  privacyRatio: number;
  /** Fee that would have been paid had both sides swapped separately. */
  counterfactualFee: bigint;
  /** Fee actually paid, on the residual only. */
  actualFee: bigint;
  /** Fee saved, in quote units. */
  feeSaved: bigint;
  /** Price impact avoided by not pushing both sides through the curve. */
  impactSaved: bigint;
  /** Total execution improvement, in quote units. */
  totalSaved: bigint;
  /** Improvement as basis points of epoch notional. */
  savedBps: number;
  /** Notional that a searcher could have targeted, but could not see. */
  mevSurfaceHidden: bigint;
  hasData: boolean;
};

/**
 * @param epoch    a settled epoch
 * @param reserves pool balances (used as constant-product reserves)
 * @param priceQuotePerBase  quote units per 1e18 base, for unit conversion
 */
export function epochSavings(
  epoch: Epoch,
  reserves: Reserves,
  priceQuotePerBase: bigint,
): EpochSavings {
  const empty: EpochSavings = {
    crossedQuote: 0n,
    routedQuote: 0n,
    privacyRatio: 0,
    counterfactualFee: 0n,
    actualFee: 0n,
    feeSaved: 0n,
    impactSaved: 0n,
    totalSaved: 0n,
    savedBps: 0,
    mevSurfaceHidden: 0n,
    hasData: false,
  };
  if (!epoch || epoch.state !== 5) return empty;
  if (epoch.buyTotal === 0n && epoch.sellTotal === 0n) return empty;

  const toQuote = (base: bigint) => (base * priceQuotePerBase) / 10n ** 18n;

  const buyQuote = epoch.buyTotal; // buyers deposit quote
  const sellQuote = toQuote(epoch.sellTotal); // sellers deposit base
  const notional = buyQuote + sellQuote;
  if (notional === 0n) return empty;

  // Matched volume is min(buy, sell) valued in quote; the contract already
  // computed the seller side of that as sellOutTotal.
  const crossedQuote = epoch.sellOutTotal > 0n ? epoch.sellOutTotal : (buyQuote < sellQuote ? buyQuote : sellQuote);
  const routedQuote =
    epoch.residual === 2
      ? toQuote(epoch.residualIn) // sell-heavy: residual is base
      : epoch.residualIn; // buy-heavy: residual is quote

  // --- counterfactual: both sides swap independently ---
  const cfBuyOut = amountOut(buyQuote, reserves.quote, reserves.base);
  const cfBuyIdeal = idealOut(buyQuote, reserves.quote, reserves.base);
  const cfBuyLossQuote = toQuote(cfBuyIdeal - cfBuyOut);

  const cfSellOut = amountOut(epoch.sellTotal, reserves.base, reserves.quote);
  const cfSellIdeal = idealOut(epoch.sellTotal, reserves.base, reserves.quote);
  const cfSellLossQuote = cfSellIdeal - cfSellOut;

  const counterfactualLoss = cfBuyLossQuote + cfSellLossQuote;

  // --- actual: only the residual swapped ---
  let actualLoss = 0n;
  if (routedQuote > 0n) {
    if (epoch.residual === 1) {
      const out = amountOut(epoch.residualIn, reserves.quote, reserves.base);
      const ideal = idealOut(epoch.residualIn, reserves.quote, reserves.base);
      actualLoss = toQuote(ideal - out);
    } else if (epoch.residual === 2) {
      const out = amountOut(epoch.residualIn, reserves.base, reserves.quote);
      const ideal = idealOut(epoch.residualIn, reserves.base, reserves.quote);
      actualLoss = ideal - out;
    }
  }

  // Split the improvement into its fee and impact components.
  const cfFee = (buyQuote * FEE_BPS) / BPS + (sellQuote * FEE_BPS) / BPS;
  const actualFee = (routedQuote * FEE_BPS) / BPS;
  const feeSaved = cfFee > actualFee ? cfFee - actualFee : 0n;
  const totalSaved = counterfactualLoss > actualLoss ? counterfactualLoss - actualLoss : 0n;
  const impactSaved = totalSaved > feeSaved ? totalSaved - feeSaved : 0n;

  return {
    crossedQuote,
    routedQuote,
    privacyRatio: notional > 0n ? Number((crossedQuote * 10000n) / notional) / 10000 : 0,
    counterfactualFee: cfFee,
    actualFee,
    feeSaved,
    impactSaved,
    totalSaved,
    savedBps: notional > 0n ? Number((totalSaved * 10000n) / notional) : 0,
    // Every order was invisible while live, so the whole epoch notional was
    // shielded from targeting — not just the part that never traded.
    mevSurfaceHidden: notional,
    hasData: true,
  };
}

export function sumSavings(list: EpochSavings[]): EpochSavings {
  return list.reduce<EpochSavings>(
    (a, s) => ({
      crossedQuote: a.crossedQuote + s.crossedQuote,
      routedQuote: a.routedQuote + s.routedQuote,
      privacyRatio: 0,
      counterfactualFee: a.counterfactualFee + s.counterfactualFee,
      actualFee: a.actualFee + s.actualFee,
      feeSaved: a.feeSaved + s.feeSaved,
      impactSaved: a.impactSaved + s.impactSaved,
      totalSaved: a.totalSaved + s.totalSaved,
      savedBps: 0,
      mevSurfaceHidden: a.mevSurfaceHidden + s.mevSurfaceHidden,
      hasData: a.hasData || s.hasData,
    }),
    {
      crossedQuote: 0n,
      routedQuote: 0n,
      privacyRatio: 0,
      counterfactualFee: 0n,
      actualFee: 0n,
      feeSaved: 0n,
      impactSaved: 0n,
      totalSaved: 0n,
      savedBps: 0,
      mevSurfaceHidden: 0n,
      hasData: false,
    },
  );
}
