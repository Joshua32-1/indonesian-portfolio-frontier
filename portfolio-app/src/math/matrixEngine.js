/**
 * matrixEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Portfolio math utilities:
 *   • Pearson correlation from adjustable weekly price-history windows
 *   • Theta-decay daily volatility (σ_daily · √252 for annualisation)
 *   • Covariance matrix construction and portfolio risk metrics
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Physical constants ────────────────────────────────────────────────────────

/** Standard equity annualisation factor (252 trading days per year). */
export const SQRT_252 = Math.sqrt(252); // ≈ 15.874

/** Trading days in the volatility lookback window (~1 calendar year). */
export const VOL_LOOKBACK_DAYS = 252;

/**
 * Default half-life for theta-decay vol weighting (trading days).
 * At 63 days, observations one quarter ago carry half the weight of today.
 */
export const DEFAULT_VOL_HALF_LIFE = 63;

/** Safe fallback when return history is too short. */
export const FALLBACK_DAILY_VOL = 0.015;

/** Minimum weekly return observations before correlation estimates are trusted. */
export const MIN_CORR_OBS = 20;

// ── 1.  Pearson Correlation Coefficient  ─────────────────────────────────────

/**
 * Computes Pearson r between two equal-length numeric arrays.
 * Returns 0 for degenerate inputs (< 3 observations, zero variance).
 */
function pearsonR(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  let sx = 0, sy = 0, sx2 = 0, sy2 = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx  += x[i]; sy  += y[i];
    sx2 += x[i] * x[i]; sy2 += y[i] * y[i];
    sxy += x[i] * y[i];
  }
  const num   = n * sxy - sx * sy;
  const denom = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  if (denom === 0) return 0;
  return Math.max(-1, Math.min(1, num / denom));
}

// ── 2.  Price-History Correlation (date-range adjustable)  ───────────────────

/**
 * @typedef {{ interval?: string, dates: string[], adjClose: number[] }} PriceHistory
 */

/**
 * Maps a Yahoo weekly bar to the canonical Tuesday week key used by IDX listings.
 *
 * Most .JK tickers anchor weekly bars on Tuesday. Some listings (e.g. NCKL) use
 * Sunday dates exactly two days earlier for the same economic week — naive ISO-week
 * bucketing would slip those bars into the adjacent week, so we normalise explicitly:
 *   • Tuesday → unchanged
 *   • Sunday  → +2 days (the matching Tuesday for that weekly period)
 *   • Other weekdays → Tuesday of the same Mon–Sun calendar week
 *
 * @param {string} isoDate — YYYY-MM-DD
 * @returns {string}
 */
export function canonicalWeeklyKey(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const dow = d.getUTCDay();

  if (dow === 2) return isoDate;

  if (dow === 0) {
    d.setUTCDate(d.getUTCDate() + 2);
    return d.toISOString().slice(0, 10);
  }

  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (dow - 1));
  const tuesday = new Date(monday);
  tuesday.setUTCDate(monday.getUTCDate() + 1);
  return tuesday.toISOString().slice(0, 10);
}

/**
 * Indexes weekly prices by canonical week key. Duplicate keys within one series
 * keep the latest source bar (guards against overlapping weekday anchors).
 *
 * @param {PriceHistory} history
 * @returns {Map<string, { sourceDate: string, price: number }>}
 */
function historyByWeekKey(history) {
  const map = new Map();
  const dates = history?.dates ?? [];
  const prices = history?.adjClose ?? [];

  for (let i = 0; i < dates.length; i++) {
    const sourceDate = dates[i];
    const price = prices[i];
    if (price == null) continue;

    const key = canonicalWeeklyKey(sourceDate);
    const prev = map.get(key);
    if (!prev || sourceDate > prev.sourceDate) {
      map.set(key, { sourceDate, price });
    }
  }

  return map;
}

/**
 * Returns sorted intersection of canonical weekly keys across price histories.
 * @param {PriceHistory[]} histories
 * @returns {string[]}
 */
export function commonPriceDates(histories) {
  if (!histories?.length) return [];
  const maps = histories.map(historyByWeekKey);
  return [...maps[0].keys()]
    .filter(key => maps.every(map => map.has(key)))
    .sort();
}

/**
 * Builds aligned close-price rows on common canonical weekly keys.
 * @param {{ id: string, history: PriceHistory }[]} series
 * @returns {Array<{ date: string, [id: string]: number }>}
 */
export function alignPriceSeries(series) {
  const keyed = series.map(s => ({ id: s.id, map: historyByWeekKey(s.history) }));
  const common = commonPriceDates(series.map(s => s.history));

  return common.map(key => {
    const row = { date: key };
    for (const { id, map } of keyed) {
      row[id] = map.get(key)?.price;
    }
    return row;
  });
}

/**
 * Percent log-returns from an aligned price array.
 * @param {number[]} prices
 * @returns {number[]}
 */
export function logReturnsFromPrices(prices) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] != null && prices[i - 1] != null && prices[i - 1] > 0) {
      rets.push(+(Math.log(prices[i] / prices[i - 1]) * 100).toFixed(4));
    }
  }
  return rets;
}

/**
 * Computes Pearson correlation matrix from weekly price histories over a date window.
 * Uses only weeks where every asset has a valid price so return vectors stay synchronized.
 *
 * @param {Asset[]} assets — must include priceHistory
 * @param {string}  startISO — inclusive
 * @param {string}  endISO   — inclusive
 * @returns {{ matrix: number[][], labels: string[], obs: number }}
 */
export function computeCorrelationFromDateRange(assets, startISO, endISO) {
  const labels = assets.map(a => a.ticker);
  const aligned = alignPriceSeries(
    assets.map(a => ({ id: a.ticker, history: a.priceHistory })),
  ).filter(row => row.date >= startISO && row.date <= endISO);

  const complete = aligned.filter(row =>
    labels.every(ticker => row[ticker] != null && row[ticker] > 0),
  );

  const returnSeries = labels.map(ticker =>
    logReturnsFromPrices(complete.map(row => row[ticker])),
  );

  const n = assets.length;
  const mat = Array.from({ length: n }, () => new Array(n).fill(0));
  const obs = returnSeries[0]?.length ?? 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) { mat[i][j] = 1.0; continue; }
      if (j < i)   { mat[i][j] = mat[j][i]; continue; }
      mat[i][j] = pearsonR(returnSeries[i], returnSeries[j]);
    }
  }

  return { matrix: mat, labels, obs };
}

/**
 * Chart rows: indexed performance (100 = window start) for each series + IHSG.
 * @param {Asset[]} assets
 * @param {PriceHistory|null} benchmarkHistory
 * @param {string} chartStartISO
 * @param {string} chartEndISO
 * @returns {Array<{ date: string, [key: string]: number|string }>}
 */
export function buildIndexedChartData(assets, benchmarkHistory, chartStartISO, chartEndISO) {
  const series = assets.map(a => ({ id: a.ticker, history: a.priceHistory }));
  if (benchmarkHistory?.dates?.length) {
    series.push({ id: 'IHSG', history: benchmarkHistory });
  }

  const aligned = alignPriceSeries(series).filter(
    row => row.date >= chartStartISO && row.date <= chartEndISO,
  );
  if (!aligned.length) return [];

  const ids = series.map(s => s.id);
  const bases = {};
  for (const id of ids) bases[id] = aligned[0][id];

  return aligned.map(row => {
    const out = { date: row.date };
    for (const id of ids) {
      const base = bases[id];
      const px = row[id];
      out[id] = base > 0 && px != null ? +((px / base) * 100).toFixed(2) : null;
    }
    return out;
  });
}

/**
 * Min/max available dates across assets and optional benchmark (union of all series).
 * @param {Asset[]} assets
 * @param {PriceHistory|null} benchmarkHistory
 * @returns {{ min: string, max: string }|null}
 */
export function availableHistoryRange(assets, benchmarkHistory) {
  const allDates = [];
  for (const a of assets) {
    if (a.priceHistory?.dates?.length) allDates.push(...a.priceHistory.dates);
  }
  if (benchmarkHistory?.dates?.length) allDates.push(...benchmarkHistory.dates);
  if (!allDates.length) return null;
  allDates.sort();
  return { min: allDates[0], max: allDates[allDates.length - 1] };
}

/**
 * Min/max dates where every asset has a weekly price (intersection / aligned range).
 * Use this for correlation windows — disabled short-history stocks are excluded upstream.
 *
 * @param {Asset[]} assets
 * @param {PriceHistory|null} [benchmarkHistory]
 * @returns {{ min: string, max: string }|null}
 */
/** Local calendar date as YYYY-MM-DD (for correlation window end caps). */
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function alignedHistoryRange(assets, benchmarkHistory = null) {
  const histories = assets
    .filter(a => a.priceHistory?.dates?.length)
    .map(a => a.priceHistory);
  if (benchmarkHistory?.dates?.length) histories.push(benchmarkHistory);
  if (!histories.length) return null;

  const common = commonPriceDates(histories);
  if (!common.length) return null;
  return { min: common[0], max: common[common.length - 1] };
}

// ── 3.  Theta-Decay Volatility  ───────────────────────────────────────────────

/**
 * Exponential decay weight for an observation `ageDays` before the most recent point.
 * Weight halves every `halfLifeDays` trading days:  w = 0.5^(age / halfLife).
 *
 * @param {number} ageDays
 * @param {number} halfLifeDays
 * @returns {number}
 */
export function thetaDecayWeight(ageDays, halfLifeDays) {
  if (halfLifeDays <= 0) return ageDays === 0 ? 1 : 0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Computes daily σ from decimal log-returns using theta-decay weighting.
 *
 * Returns are ordered oldest → newest.  The final element is weighted most heavily;
 * observations outside the lookback window should be trimmed before calling.
 *
 * @param {number[]} dailyReturns  — decimal log-returns (e.g. 0.0123 = +1.23%)
 * @param {number}   halfLifeDays  — decay half-life in trading days
 * @returns {number}  σ_daily as a decimal
 */
export function computeThetaDecayedVol(dailyReturns, halfLifeDays = DEFAULT_VOL_HALF_LIFE) {
  const n = dailyReturns?.length ?? 0;
  if (n < 2) return FALLBACK_DAILY_VOL;

  const lookback = dailyReturns.slice(-VOL_LOOKBACK_DAYS);
  const m = lookback.length;
  if (m < 2) return FALLBACK_DAILY_VOL;

  let weightSum = 0;
  let weightedMean = 0;
  for (let i = 0; i < m; i++) {
    const age = m - 1 - i;
    const w = thetaDecayWeight(age, halfLifeDays);
    weightSum += w;
    weightedMean += w * lookback[i];
  }
  weightedMean /= weightSum;

  let weightedVar = 0;
  for (let i = 0; i < m; i++) {
    const age = m - 1 - i;
    const w = thetaDecayWeight(age, halfLifeDays);
    const diff = lookback[i] - weightedMean;
    weightedVar += w * diff * diff;
  }
  weightedVar /= weightSum;

  return +Math.sqrt(Math.max(0, weightedVar)).toFixed(6);
}

/**
 * Resolves σ_daily for an asset, preferring theta-decayed vol from stored
 * daily returns and falling back to the snapshot's precomputed value.
 *
 * @param {Asset}  asset
 * @param {number} halfLifeDays
 * @returns {number}
 */
export function resolveDailyVol(asset, halfLifeDays = DEFAULT_VOL_HALF_LIFE) {
  const stored = asset.meta?.dailyReturns;
  if (stored?.length >= 2) {
    return computeThetaDecayedVol(stored, halfLifeDays);
  }
  return asset.meta?.recentDailyVol ?? FALLBACK_DAILY_VOL;
}

// ── 4.  Annualised Covariance Matrix  ─────────────────────────────────────────

/**
 * Ledoit-Wolf analytical shrinkage (Ledoit & Wolf 2004, "Honey, I Shrunk the
 * Sample Covariance Matrix").  Shrinks sample Σ toward a scaled identity:
 *
 *   Σ_shrunk = (1 − α) · Σ_sample + α · μ̄ · I
 *
 * where μ̄ = trace(Σ) / n and α is the optimal Oracle-approximating shrinkage
 * intensity.  This is the simplest analytical LW estimator; it does not require
 * the full Oracle formula (which would need the true Σ) but converges to the
 * correct shrinkage intensity as T → ∞.
 *
 * Useful when n/T is not small (e.g. 40 assets, 100 weekly obs ≈ 2 years).
 *
 * @param {number[][]} S     — sample covariance matrix (n × n)
 * @param {number}     nObs  — number of observations used to build S
 * @returns {number[][]}      shrunk covariance matrix
 */
export function ledoitWolfShrinkage(S, nObs) {
  const n = S.length;
  if (n < 2 || nObs < n + 1) return S.map(row => [...row]);

  const T = nObs;

  // Trace and Frobenius-norm helpers
  let trS = 0;
  let frob2 = 0;
  for (let i = 0; i < n; i++) {
    trS += S[i][i];
    for (let j = 0; j < n; j++) frob2 += S[i][j] * S[i][j];
  }

  const muBar = trS / n;

  // Estimate squared Frobenius norm of (S − μ̄ I)
  const delta2 = frob2 - 2 * muBar * trS + n * muBar * muBar;
  if (delta2 <= 1e-20) return S.map(row => [...row]);

  // Oracle-approximating shrinkage intensity (capped to [0, 1])
  const alpha = Math.max(0, Math.min(1, (delta2 / (T * frob2 / n))));

  return S.map((row, i) =>
    row.map((val, j) => {
      if (i === j) return (1 - alpha) * val + alpha * muBar;
      return (1 - alpha) * val;
    }),
  );
}

/**
 * Builds the covariance matrix Σ using ANNUALISED volatilities, with optional
 * Ledoit-Wolf shrinkage to reduce estimation error when history is limited.
 *
 *   σ_daily   =  theta-decayed estimate from 1-year daily returns
 *   σ_annual  =  σ_daily · √252
 *   Σᵢⱼ       =  ρᵢⱼ · σᵢ_annual · σⱼ_annual
 *
 * @param {number[][]} corrMatrix  — from computeCorrelationFromDateRange()
 * @param {Asset[]}    assets
 * @param {{ volHalfLife?: number, shrinkage?: boolean, nObs?: number }} [options]
 * @returns {{ covMatrix: number[][], annualVols: number[], dailyVols: number[] }}
 */
export function computeCovarianceMatrix(corrMatrix, assets, { volHalfLife = DEFAULT_VOL_HALF_LIFE, shrinkage = true, nObs = 0 } = {}) {
  const dailyVols = assets.map(a => resolveDailyVol(a, volHalfLife));
  const annualVols = dailyVols.map(v => v * SQRT_252);
  const n = assets.length;
  let covMatrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      corrMatrix[i][j] * annualVols[i] * annualVols[j]
    )
  );
  if (shrinkage && nObs > n) {
    covMatrix = ledoitWolfShrinkage(covMatrix, nObs);
  }
  return { covMatrix, annualVols, dailyVols };
}

/**
 * Augments price covariance with liquidity risk on the diagonal.
 * Analyst disagreement is handled via BL view uncertainty (dispersionOmega → Ω), not Σ.
 * No-op when factor model inactive or liquidity toggle off / penalty at 0.
 */
export function augmentCovarianceMatrix(covMatrix, perAssetFactors, factorConfig) {
  if (!factorConfig?.useFactorModel) return covMatrix;

  const useLiq = factorConfig.useLiquidityRisk && (factorConfig.liquidityPenalty ?? 0) > 0;
  if (!useLiq) return covMatrix;

  const liqPenalty = factorConfig.liquidityPenalty ?? 0;

  return covMatrix.map((row, i) =>
    row.map((val, j) => {
      if (i !== j) return val;
      const liqScore = perAssetFactors[i]?.liquidityScore ?? 0.5;
      return Math.max(val * (1 + liqPenalty * (1 - liqScore)), 1e-12);
    }),
  );
}

// ── 5.  Portfolio-Level Metrics  ──────────────────────────────────────────────

/**
 * Empirical quantile with linear interpolation (Hyndman-Fan type 7 — matches
 * NumPy/R default). `sorted` must be ascending-sorted.
 * @param {number[]} sorted
 * @param {number} p  probability in (0, 1)
 */
export function empiricalQuantile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const clamped = Math.max(0, Math.min(1, p));
  const h = (n - 1) * clamped;
  const i = Math.floor(h);
  const frac = h - i;
  if (i >= n - 1) return sorted[n - 1];
  return sorted[i] + frac * (sorted[i + 1] - sorted[i]);
}

/** wᵀμ — weighted expected return. */
export function portfolioReturn(weights, means) {
  return weights.reduce((s, w, i) => s + w * means[i], 0);
}

/** wᵀΣw — portfolio variance (returns annualised² when Σ is annualised). */
export function portfolioVariance(weights, covMatrix) {
  const n = weights.length;
  let v = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      v += weights[i] * weights[j] * covMatrix[i][j];
  return Math.max(0, v);
}

/** (μ_p − r_f) / σ_p  —  Sharpe ratio. All inputs must be in the same units. */
export function sharpeRatio(ret, risk, rf = 0.0575) {
  return risk <= 0 ? 0 : (ret - rf) / risk;
}

/** Reconcile stored Sharpe from portfolio return and risk (single source of truth). */
export function reconcilePortfolioSharpe(portfolio, rf = 0.0575) {
  if (!portfolio) return 0;
  return sharpeRatio(portfolio.portfolioReturn ?? 0, portfolio.portfolioRisk ?? 0, rf);
}

/**
 * Marginal risk contributions: the fraction of total portfolio variance
 * attributable to each asset.
 *
 *   (Σw)ᵢ  =  sum_j w_j Σᵢⱼ    (marginal contribution to variance)
 *   RC_i   =  wᵢ · (Σw)ᵢ / (wᵀΣw)
 *
 * @returns {number[]}  fractions summing to 1
 */
export function computeRiskContributions(weights, covMatrix) {
  const n = weights.length;
  const sigmaw = weights.map((_, i) =>
    weights.reduce((s, wj, j) => s + wj * covMatrix[i][j], 0)
  );
  const totalVar = weights.reduce((s, wi, i) => s + wi * sigmaw[i], 0);
  if (totalVar <= 0) return weights.map(() => 1 / n);
  return weights.map((wi, i) => (wi * sigmaw[i]) / totalVar);
}

/** Bar width 0–100 for RC visualization (negative RC → 0, avoids invalid CSS widths). */
export function riskContributionBarWidth(rcFrac) {
  if (!Number.isFinite(rcFrac)) return 0;
  return Math.max(0, Math.min(rcFrac * 100, 100));
}

/** Signed RC label, one decimal (e.g. "-0.3%", "16.2%"). */
export function formatRiskContributionPct(rcFrac) {
  if (!Number.isFinite(rcFrac)) return '—';
  return `${(rcFrac * 100).toFixed(1)}%`;
}

// ── 6.  Cholesky Decomposition  ───────────────────────────────────────────────

/**
 * Cholesky-Banachiewicz decomposition: returns lower-triangular L such that
 * L·Lᵀ = Σ (the covariance matrix).
 *
 * Used to draw correlated asset return shocks: if z ~ N(0,I) then L·z ~ N(0,Σ).
 * This lets tail metrics and the robust objective properly propagate cross-asset
 * correlation into each simulated realization, not just portfolio-level σ.
 *
 * Numerical safety: diagonal entries that go negative due to floating-point
 * error (near-singular Σ after Ledoit-Wolf) are clamped to zero, giving a
 * valid-but-degenerate factor rather than NaN.  The resulting shocks are
 * still correct for all assets whose rows are non-zero.
 *
 * @param {number[][]} covMatrix  — symmetric positive-semidefinite n×n matrix
 * @returns {number[][]}           lower-triangular Cholesky factor L (n×n)
 */
export function choleskyDecompose(covMatrix) {
  const n = covMatrix.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = covMatrix[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(0, sum));
      } else {
        L[i][j] = L[j][j] > 1e-14 ? sum / L[j][j] : 0;
      }
    }
  }
  return L;
}