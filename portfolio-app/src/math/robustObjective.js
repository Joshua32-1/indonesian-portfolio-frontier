/**
 * robustObjective.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tail-aware robust objective functions, CVaR metrics, and turnover helpers.
 *
 * Two optimisation modes:
 *   'tailAware'   — Sharpe(avg μ) − λ · (tailGap / σ_ref) − κ · turnover
 *   'avgMuSharpe' — legacy: Sharpe on average scenario returns (no tail penalty)
 *
 * Anti-overfit design:
 *   • Optimizer uses a fixed subsample of scenarios (default 1 000 paths).
 *   • Full scenario set is only used for *reporting* in computeScenarioStats.
 *   • tailGap = E[r] − CVaR₅% is a smooth risk penalty, not worst-case min-max.
 *   • σ_ref normalises λ across different universes so the slider is portable.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { portfolioReturn, portfolioVariance, sharpeRatio, empiricalQuantile } from './matrixEngine.js';
import { DEFAULT_TAIL_PENALTY } from './simConfig.js';

export const ROBUST_SUBSAMPLE_SIZE = 1000;

/**
 * Seedable PRNG (mulberry32) — returns a function () → float ∈ [0, 1).
 *
 * Opt-in: callers that want byte-reproducible draws build one of these and pass
 * it down as `rng`. When omitted, the samplers default to `Math.random`, so the
 * production optimizer and the validation suite are byte-identical to before.
 *
 * @param {number} seed  32-bit unsigned seed
 * @returns {() => number}
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller standard-normal sampler (internal). `rng` defaults to Math.random. */
function normalRand(rng = Math.random) {
  let u, v, s;
  do { u = 2 * rng() - 1; v = 2 * rng() - 1; s = u * u + v * v; }
  while (s >= 1 || s === 0);
  return u * Math.sqrt((-2 * Math.log(s)) / s);
}

/**
 * Draw `nPaths` correlated log-return shock vectors using the Cholesky factor L
 * of the covariance matrix (L·Lᵀ = Σ).
 *
 * For each path:
 *   z ~ N(0, I_n)   (independent standard normals)
 *   ε = L·z         → ε ~ N(0, Σ)   (correlated, annualised log-return shocks)
 *
 * Returns a nPaths × nAssets matrix.  Pre-drawn once per run and reused across
 * optimizer evaluations so the landscape is stable during hill-climbing.
 *
 * @param {number[][]} choleskyL  — lower-triangular Cholesky factor (n × n)
 * @param {number}     nPaths     — number of shock vectors to draw
 * @param {() => number} [rng]    — uniform sampler; defaults to Math.random (pass a
 *                                  makeRng(seed) for reproducible draws)
 * @returns {number[][]}           nPaths × n matrix of correlated shocks
 */
export function drawCorrelatedShocks(choleskyL, nPaths, rng = Math.random) {
  const n = choleskyL.length;
  return Array.from({ length: nPaths }, () => {
    // NB: an explicit arrow is required — Array.from passes (elem, index) to its
    // callback, so a bare `normalRand` reference would bind rng = index.
    const z = Array.from({ length: n }, () => normalRand(rng));
    // L·z: row i of L dotted with z
    return choleskyL.map(row => row.reduce((s, lij, j) => s + lij * z[j], 0));
  });
}

/** Evenly-spaced indices for deterministic subsampling (no randomness). */
export function pickEvenlySpacedIndices(total, count) {
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  if (count <= 1) return [0];
  const indices = [];
  for (let k = 0; k < count; k++) {
    indices.push(Math.floor((k * (total - 1)) / (count - 1)));
  }
  return indices;
}

/** Diagonal of Σ (per-asset return variance). */
export function covDiag(covMatrix) {
  return covMatrix.map((row, i) => row[i]);
}

/**
 * Lognormal one-year simple return from analyst μ and a correlated log shock.
 * E[result] ≈ μ when shock ~ N(0, Σ_jj) via the −Σ_jj/2 Ito correction.
 */
export function realizedSimpleReturn(mu, shock, varDiag) {
  return Math.expm1(Math.log1p(Math.max(mu, -0.9999)) - varDiag / 2 + shock);
}

/**
 * Portfolio returns across MC paths with asset-level correlated lognormal shocks.
 * @param {number[]}     weights
 * @param {number[][]}   scenarios      — nPaths × nAssets analyst return vectors
 * @param {number[][]}   shockMatrix    — nPaths × nAssets correlated ε ~ N(0,Σ)
 * @param {number[]}     sigDiag        — diag(Σ)
 * @returns {number[]}
 */
export function computeRealizedPortfolioReturns(weights, scenarios, shockMatrix, sigDiag) {
  return scenarios.map((means, i) => {
    const shocks = shockMatrix[i];
    const realized = means.map((mu, j) => realizedSimpleReturn(mu, shocks[j], sigDiag[j]));
    return portfolioReturn(weights, realized);
  });
}

/**
 * Computes tail metrics from a portfolio's scenario return distribution.
 *
 * @param {number[]} returns     — unsorted portfolio returns across scenarios
 * @param {number}   riskFreeRate
 * @returns {{
 *   cvar5: number,         — CVaR at 5% (expected shortfall of worst 5%)
 *   returnP10: number,
 *   returnP50: number,
 *   returnP90: number,
 *   meanReturn: number,
 *   tailGap: number,       — meanReturn − cvar5 (wider = fatter left tail)
 *   probBelowRf: number,   — fraction of scenarios below risk-free rate
 *   probNegative: number,  — fraction of scenarios with negative return
 * }}
 */
export function computeTailMetrics(returns, riskFreeRate) {
  if (!returns.length) {
    return { cvar5: 0, returnP10: 0, returnP50: 0, returnP90: 0, meanReturn: 0, tailGap: 0, probBelowRf: 0, probNegative: 0 };
  }
  const sorted = [...returns].sort((a, b) => a - b);
  const n = sorted.length;
  const meanReturn = sorted.reduce((s, v) => s + v, 0) / n;

  const cutIdx = Math.max(1, Math.floor(n * 0.05));
  const cvar5 = sorted.slice(0, cutIdx).reduce((s, v) => s + v, 0) / cutIdx;

  const tailGap = meanReturn - cvar5;
  const probBelowRf = sorted.filter(r => r < riskFreeRate).length / n;
  const probNegative = sorted.filter(r => r < 0).length / n;

  return {
    cvar5,
    returnP10: empiricalQuantile(sorted, 0.10),
    returnP50: empiricalQuantile(sorted, 0.50),
    returnP90: empiricalQuantile(sorted, 0.90),
    meanReturn,
    tailGap,
    probBelowRf,
    probNegative,
  };
}

/**
 * Builds the objective function used during robust portfolio optimisation.
 *
 * @param {{
 *   mode: 'tailAware' | 'avgMuSharpe',
 *   subsampleScenarios: number[][],    — pre-selected subsample (ROBUST_SUBSAMPLE_SIZE = 1000 paths)
 *   avgMeans: number[],                — mean of subsample per asset
 *   covMatrix: number[][],
 *   riskFreeRate: number,
 *   tailPenalty: number,               — λ: tail-gap penalty weight (0 = no penalty)
 *   sigmaRef: number,                  — σ at equal-weight (for normalising λ)
 *   currentWeights: number[]|null,     — fractions; null = no turnover penalty
 *   turnoverPenalty: number,           — κ: one-way turnover cost weight
 *   realizationShocks: number[][]|null — nPaths × nAssets correlated log-return
 *                                        shocks from drawCorrelatedShocks(L).
 *                                        When present, each path's portfolio return is:
 *                                          r_j = exp(ln(1+μ_j) − Σ_jj/2 + ε_j) − 1
 *                                          r_p = w · r_vec
 *                                        giving lognormal asset returns with E[r_j]=μ_j
 *                                        and correlated shocks matching Σ exactly.
 * }} opts
 * @returns {(w: number[]) => number}
 */
export function buildObjectiveFn({
  mode,
  subsampleScenarios,
  avgMeans,
  covMatrix,
  riskFreeRate,
  tailPenalty = DEFAULT_TAIL_PENALTY,
  sigmaRef = 1,
  currentWeights = null,
  turnoverPenalty = 0,
  realizationShocks = null,
}) {
  if (mode === 'avgMuSharpe') {
    return (w) => {
      const risk = Math.sqrt(portfolioVariance(w, covMatrix));
      return sharpeRatio(portfolioReturn(w, avgMeans), risk, riskFreeRate);
    };
  }

  // Ito drift correction per asset: ln(1+μ) − Σᵢᵢ/2
  const sigDiag = realizationShocks ? covDiag(covMatrix) : null;

  return (w) => {
    const risk = Math.sqrt(portfolioVariance(w, covMatrix));
    const baseSharpe = sharpeRatio(portfolioReturn(w, avgMeans), risk, riskFreeRate);

    let penalty = 0;
    if (tailPenalty > 0 && sigmaRef > 1e-10 && realizationShocks) {
      const rets = computeRealizedPortfolioReturns(w, subsampleScenarios, realizationShocks, sigDiag);
      const { tailGap } = computeTailMetrics(rets, riskFreeRate);
      penalty += tailPenalty * (tailGap / sigmaRef);
    }

    if (turnoverPenalty > 0 && currentWeights) {
      const oneWayTurnover = w.reduce((s, wi, i) => s + Math.abs(wi - (currentWeights[i] ?? 0)), 0) / 2;
      penalty += turnoverPenalty * oneWayTurnover;
    }

    return baseSharpe - penalty;
  };
}

/**
 * Compute one-way portfolio turnover (0 = no change, 1 = full rebalance).
 * @param {number[]} wTarget
 * @param {number[]} wCurrent
 * @returns {number}
 */
export function computeTurnover(wTarget, wCurrent) {
  if (!wCurrent || !wCurrent.length) return 0;
  return wTarget.reduce((s, wi, i) => s + Math.abs(wi - (wCurrent[i] ?? 0)), 0) / 2;
}

/**
 * Per-asset trade list from current to target weights.
 * @param {Asset[]} assets
 * @param {number[]} targetWeights
 * @param {number[]} currentWeights  — fractions (0–1)
 * @returns {Array<{ ticker, sector, current, target, delta, trade }>}
 */
export function buildRebalanceTrades(assets, targetWeights, currentWeights) {
  return assets.map((a, i) => {
    const current = currentWeights?.[i] ?? 0;
    const target  = targetWeights[i] ?? 0;
    const delta   = target - current;
    const trade   = Math.abs(delta) < 0.001 ? 'HOLD' : delta > 0 ? 'BUY' : 'SELL';
    return { ticker: a.ticker, sector: a.sector, current, target, delta, trade };
  });
}
