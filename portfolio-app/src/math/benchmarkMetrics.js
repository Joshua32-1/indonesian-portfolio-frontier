/**
 * benchmarkMetrics.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic metrics vs IHSG benchmark.
 * These are read-only analytics — NOT used as optimizer constraints (which
 * would overfit to index weights we don't fully know).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logReturnsFromPrices, alignPriceSeries } from './matrixEngine.js';

/**
 * Computes portfolio beta, correlation, and approximate active risk vs IHSG
 * using the price-history correlation window.
 *
 * @param {Asset[]}      assets
 * @param {number[]}     weights        — portfolio weight per asset (fractions)
 * @param {PriceHistory} benchmarkHistory
 * @param {string}       startISO
 * @param {string}       endISO
 * @returns {{
 *   beta:         number,
 *   correlation:  number,
 *   activeRisk:   number|null,   — annualised (requires σ of benchmark)
 *   benchmarkVol: number,
 *   portfolioVol: number,
 * } | null}
 */
export function computeBenchmarkMetrics(assets, weights, benchmarkHistory, startISO, endISO) {
  if (!benchmarkHistory?.dates?.length || !assets.length) return null;

  const series = [
    ...assets.map(a => ({ id: a.ticker, history: a.priceHistory })),
    { id: 'IHSG', history: benchmarkHistory },
  ];

  const aligned = alignPriceSeries(series).filter(
    row => row.date >= startISO && row.date <= endISO,
  );
  if (aligned.length < 10) return null;

  const SQRT_52 = Math.sqrt(52); // weekly data

  // Build asset return matrix
  const assetReturns = assets.map(a => {
    const prices = aligned.map(row => row[a.ticker]).filter(v => v != null);
    return logReturnsFromPrices(prices).map(r => r / 100);
  });

  const benchPrices = aligned.map(row => row['IHSG']).filter(v => v != null);
  const benchReturns = logReturnsFromPrices(benchPrices).map(r => r / 100);

  const T = benchReturns.length;
  if (T < 8) return null;

  // Portfolio return per period = w·r_t
  const nAssets = assets.length;
  const minLen = Math.min(T, ...assetReturns.map(r => r.length));
  const portReturns = Array.from({ length: minLen }, (_, t) =>
    weights.reduce((s, w, i) => s + w * (assetReturns[i]?.[t] ?? 0), 0),
  );
  const bR = benchReturns.slice(0, minLen);

  // Means
  const meanP = portReturns.reduce((s, v) => s + v, 0) / minLen;
  const meanB = bR.reduce((s, v) => s + v, 0) / minLen;

  // Variances and covariance
  let varP = 0, varB = 0, covPB = 0;
  for (let t = 0; t < minLen; t++) {
    const dp = portReturns[t] - meanP;
    const db = bR[t] - meanB;
    varP  += dp * dp;
    varB  += db * db;
    covPB += dp * db;
  }
  varP  /= minLen - 1;
  varB  /= minLen - 1;
  covPB /= minLen - 1;

  const sigmaP = Math.sqrt(Math.max(0, varP));
  const sigmaB = Math.sqrt(Math.max(0, varB));
  const beta = varB > 1e-12 ? covPB / varB : 1;
  const correlation = (sigmaP > 1e-12 && sigmaB > 1e-12) ? covPB / (sigmaP * sigmaB) : 0;

  // Active risk σ(r_p − r_b) annualised
  const activeReturns = portReturns.map((r, t) => r - bR[t]);
  const meanActive = activeReturns.reduce((s, v) => s + v, 0) / minLen;
  let varActive = 0;
  for (const r of activeReturns) varActive += (r - meanActive) ** 2;
  varActive /= minLen - 1;
  const activeRisk = Math.sqrt(Math.max(0, varActive)) * SQRT_52;

  return {
    beta:         Math.round(beta * 1000) / 1000,
    correlation:  Math.round(correlation * 1000) / 1000,
    activeRisk,
    benchmarkVol: sigmaB * SQRT_52,
    portfolioVol: sigmaP * SQRT_52,
  };
}
