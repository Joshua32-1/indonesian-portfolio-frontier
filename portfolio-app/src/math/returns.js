/**
 * returns.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Price and total-return helpers for analyst-target upside calculations.
 * Total upside = price appreciation + dividend yield (decimal).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Dividend yield as a decimal (e.g. 0.057 = 5.7%). Null/undefined → 0. */
export function dividendYield(asset) {
  return asset?.meta?.dividendYield ?? 0;
}

/** Whether the asset has a non-zero dividend yield. */
export function hasDividend(asset) {
  return dividendYield(asset) > 0;
}

/**
 * Price-only upside from current price to a target (decimal return).
 * @returns {number|null}
 */
export function priceUpsideDecimal(currentPrice, targetPrice) {
  if (!currentPrice || targetPrice == null) return null;
  return (targetPrice - currentPrice) / currentPrice;
}

/**
 * Total upside = price appreciation + dividend yield (decimal return).
 * @returns {number|null}
 */
export function totalUpsideDecimal(currentPrice, targetPrice, yieldDecimal = 0) {
  const priceUpside = priceUpsideDecimal(currentPrice, targetPrice);
  if (priceUpside == null) return null;
  return priceUpside + (yieldDecimal ?? 0);
}

/** Consensus mean-target total upside for an asset (decimal). */
export function consensusTotalUpside(asset) {
  const px = asset?.meta?.currentPrice;
  const mean = asset?.forwardEstimates?.meanTarget;
  return totalUpsideDecimal(px, mean, dividendYield(asset)) ?? 0;
}

/** Format a decimal return as a signed percentage string. */
export function fmtUpsidePct(decimal) {
  if (decimal == null) return '—';
  const pct = decimal * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/** Target-price dispersion: (high − low) / mean. Used by BL Ω and factor scores. */
export function computeDispersion(asset) {
  const fe = asset.forwardEstimates ?? {};
  const { lowTarget, meanTarget, highTarget } = fe;
  if (!meanTarget || meanTarget <= 0) return 0;
  const low = Math.min(lowTarget ?? meanTarget, meanTarget, highTarget ?? meanTarget);
  const high = Math.max(lowTarget ?? meanTarget, meanTarget, highTarget ?? meanTarget);
  return Math.max(0, (high - low) / meanTarget);
}
