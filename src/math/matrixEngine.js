/**
 * matrixEngine.js  — REFACTORED v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Key changes from v1:
 *   • All option-style "Theta Decay" / DTE logic removed — equities do not expire.
 *   • Volatility is annualised using the standard equity rule:  σ_annual = σ_daily · √252
 *   • blendMatrices applies a sigmoid crisis-floor weight so correlations stay
 *     nearly linear in the first half of the stress slider, accelerate smoothly
 *     through the midpoint, and asymptote to CRISIS_FLOOR at full stress.
 *   • Added extractSubMatrix for dynamic asset exclusion.
 *   • Added computeRiskContributions for the Analytics tab.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Physical constants ────────────────────────────────────────────────────────

/** Standard equity annualisation factor (252 trading days per year). */
export const SQRT_252 = Math.sqrt(252); // ≈ 15.874

/**
 * Institutional crisis correlation floor.
 * Empirically, during macro panics (2008 GFC, 2020 COVID, 2022 EM rout)
 * pairwise equity correlations rarely stay below 0.80-0.85 regardless of
 * sector or style.  We use 0.82 as a conservative floor.
 */
export const CRISIS_FLOOR = 0.82;

/**
 * Steepness of the crisis-floor sigmoid (higher → sharper rise after mid-slider).
 */
export const FLOOR_SIGMOID_STEEPNESS = 14;

/**
 * Inflection point of the raw logistic (α₀ > 0.5 keeps the first half ~linear).
 */
export const FLOOR_SIGMOID_MIDPOINT = 0.72;

// ── 1.  Pearson Correlation Coefficient  ─────────────────────────────────────

/**
 * Computes Pearson r between two equal-length numeric arrays.
 * Returns 0 for degenerate inputs (< 3 observations, zero variance).
 */
export function pearsonR(x, y) {
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

// ── 2.  Anchor Correlation Matrices  ─────────────────────────────────────────

/**
 * Builds an N×N Pearson correlation matrix from a named return-series timeline.
 *
 * @param {Asset[]}  assets       — full asset array from snapshot JSON
 * @param {'regularTimeline'|'stressTimeline'} timelineKey
 * @returns {{ matrix: number[][], labels: string[] }}
 */
export function computeCorrelationMatrix(assets, timelineKey) {
  const n = assets.length;
  const mat = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j)  { mat[i][j] = 1.0; continue; }
      if (j < i)    { mat[i][j] = mat[j][i]; continue; }
      mat[i][j] = pearsonR(
        assets[i].regimeReturns[timelineKey],
        assets[j].regimeReturns[timelineKey],
      );
    }
  }
  return { matrix: mat, labels: assets.map(a => a.ticker) };
}

/**
 * Computes BOTH anchor matrices in one call.
 * Call once on app load; store results as constants.
 */
export function computeAnchorMatrices(assets) {
  const regular = computeCorrelationMatrix(assets, 'regularTimeline');
  const stress  = computeCorrelationMatrix(assets, 'stressTimeline');
  return {
    matrixA: regular.matrix, // Constant A — Regular (calm bull)
    matrixB: stress.matrix,  // Constant B — Stress  (bear/crisis)
    labels:  regular.labels,
  };
}

// ── 3.  Sub-Matrix Extraction for Asset Exclusions  ──────────────────────────

/**
 * Extracts the sub-matrix of a full N×N correlation matrix that corresponds
 * to a chosen subset of assets.  Required when the user disables assets.
 *
 * @param {number[][]} fullMatrix  — N×N matrix indexed by fullLabels
 * @param {string[]}   fullLabels  — tickers corresponding to fullMatrix rows/cols
 * @param {string[]}   subLabels   — ordered subset of tickers to extract
 * @returns {number[][]}  k×k sub-matrix (k = subLabels.length)
 */
export function extractSubMatrix(fullMatrix, fullLabels, subLabels) {
  const idx = subLabels.map(l => fullLabels.indexOf(l));
  return idx.map(i => idx.map(j => fullMatrix[i][j]));
}

// ── 4.  Sigmoid Crisis-Floor Blending  ───────────────────────────────────────

/** Standard logistic σ(x) = 1 / (1 + e^(−x)). */
function logistic(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

/**
 * Maps stress α ∈ [0, 1] to a crisis-floor blend weight w ∈ [0, 1].
 *
 * Uses a logistic shifted right of centre (α₀ = FLOOR_SIGMOID_MIDPOINT) and
 * re-scaled so w(0) = 0 and w(1) = 1:
 *
 *   w(α) = ( σ(k·(α − α₀)) − σ(−k·α₀) ) / ( σ(k·(1 − α₀)) − σ(−k·α₀) )
 *
 * Behaviour (k = 14, α₀ = 0.72):
 *   • α ≲ 0.5  → w ≈ 0–0.05  (anchor blend stays nearly linear)
 *   • α ≈ 0.65 → w ≈ 0.25    (smooth acceleration through the midpoint)
 *   • α → 1    → w → 1       (asymptotic approach to the crisis floor)
 *
 * @param {number} alpha  — stress mix α ∈ [0, 1]
 * @returns {number}        floor weight w ∈ [0, 1]
 */
export function crisisFloorWeight(alpha) {
  const α = Math.max(0, Math.min(1, alpha));
  if (α === 0) return 0;
  if (α === 1) return 1;

  const k  = FLOOR_SIGMOID_STEEPNESS;
  const α0 = FLOOR_SIGMOID_MIDPOINT;
  const raw = (a) => logistic(k * (a - α0));
  const lo  = raw(0);
  const hi  = raw(1);
  const span = hi - lo;
  if (span === 0) return α;

  return (raw(α) - lo) / span;
}

/**
 * Blends two correlation matrices with a sigmoid crisis-floor response.
 *
 *   ρ_linear   = (1 − α)·ρA + α·ρB
 *   ρ_target   = max(ρ_linear, CRISIS_FLOOR)
 *   ρ_blended  = (1 − w)·ρ_linear + w·ρ_target     where w = crisisFloorWeight(α)
 *
 * Diagonal is always 1.0.  The result is symmetric when inputs are.
 *
 * @param {number[][]} matrixA   — Regular anchor matrix
 * @param {number[][]} matrixB   — Stress  anchor matrix
 * @param {number}     stressMix — α ∈ [0, 1]
 * @returns {number[][]} blended correlation matrix
 */
export function blendMatrices(matrixA, matrixB, stressMix) {
  const α = Math.max(0, Math.min(1, stressMix));
  const w = crisisFloorWeight(α);

  return matrixA.map((row, i) =>
    row.map((aij, j) => {
      if (i === j) return 1.0;

      const linearBlend   = (1 - α) * aij + α * matrixB[i][j];
      const flooredTarget = Math.max(linearBlend, CRISIS_FLOOR);
      return linearBlend * (1 - w) + flooredTarget * w;
    })
  );
}

// ── 5.  Annualised Covariance Matrix  ─────────────────────────────────────────

/**
 * Builds the covariance matrix Σ using ANNUALISED volatilities.
 *
 *   σ_annual  =  σ_daily · √252          (standard equity rule)
 *   Σᵢⱼ       =  ρᵢⱼ_blended · σᵢ_annual · σⱼ_annual
 *
 * No "theta decay" or option-style DTE scaling — equities do not expire.
 *
 * @param {number[][]} blendedCorr  — from blendMatrices()
 * @param {Asset[]}    assets       — must have meta.recentDailyVol
 * @returns {{ covMatrix: number[][], annualVols: number[] }}
 */
export function computeCovarianceMatrix(blendedCorr, assets) {
  const annualVols = assets.map(a => a.meta.recentDailyVol * SQRT_252);
  const n = assets.length;
  const covMatrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      blendedCorr[i][j] * annualVols[i] * annualVols[j]
    )
  );
  return { covMatrix, annualVols };
}

// ── 6.  Portfolio-Level Metrics  ──────────────────────────────────────────────

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
export function sharpeRatio(ret, risk, rf = 0.0525) {
  return risk <= 0 ? 0 : (ret - rf) / risk;
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