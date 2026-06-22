/**
 * monteCarlo.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure mathematics module — no React, no side-effects.
 *
 * Robust portfolio simulation:
 *   • Beta-PERT sampling of analyst price targets → scenario return vectors μᵢ
 *   • Robust w* — tail-aware fixed allocation (Sharpe − λ·tailGap) or legacy avg-μ Sharpe
 *   • Oracle Sharpe — highest Sharpe among all per-scenario optimal allocations (not investable)
 *   • Consensus portfolio — BL/PERT mean return, single-scenario max Sharpe (implementable)
 *   • Min-variance portfolio on Σ subject to sector / position caps
 *   • Scenario-optima cloud uses all paths; robust chart layer subsampled
 *   • λ-sweep robustness frontier (7 penalty levels for Efficient Frontier overlay)
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Max robust-cloud points sent to Recharts (scenario optima use all paths). */
const CHART_MAX_POINTS = 2500;

import {
  portfolioReturn,
  portfolioVariance,
  sharpeRatio,
  augmentCovarianceMatrix,
  choleskyDecompose,
} from './matrixEngine.js';
import { resolveSectorCap, hasBindingSectorCaps as sectorCapsBind, mergePositionCaps } from './sectorCaps.js';
import { dividendYield } from './returns.js';
import { isFactorModelActive, normalizeFactorConfig } from './factorConfig.js';
import { computeQualityFactors, resolvePortfolioLiquidity } from './qualityFactors.js';
import {
  buildBlackLittermanContext,
  computePosteriorReturns,
  shouldUseBlackLitterman,
} from './blackLitterman.js';
import {
  buildObjectiveFn,
  computeTailMetrics,
  computeRealizedPortfolioReturns,
  covDiag,
  drawCorrelatedShocks,
  pickEvenlySpacedIndices,
  ROBUST_SUBSAMPLE_SIZE,
} from './robustObjective.js';
import { DEFAULT_TAIL_PENALTY } from './simConfig.js';

// ── PRNG Primitives  ──────────────────────────────────────────────────────────

function normalRand() {
  let u, v, s;
  do { u = 2 * Math.random() - 1; v = 2 * Math.random() - 1; s = u*u + v*v; }
  while (s >= 1 || s === 0);
  return u * Math.sqrt((-2 * Math.log(s)) / s);
}

/** Gamma(α,1) via Marsaglia–Tsang squeeze algorithm. */
function gammaRand(alpha) {
  if (alpha < 1) return gammaRand(1 + alpha) * Math.pow(Math.random(), 1 / alpha);
  const d = alpha - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normalRand(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x*x) * (x*x)) return d * v;
    if (Math.log(u) < 0.5 * x*x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(α,β) via ratio-of-gammas identity. */
function betaRand(alpha, beta) {
  const x = gammaRand(alpha), y = gammaRand(beta);
  const s = x + y;
  return s === 0 ? 0.5 : x / s;
}

// ── Beta-PERT Sampler  ────────────────────────────────────────────────────────

function pertSample(low, mode, high) {
  if (low >= high) return mode;
  const m = Math.max(low, Math.min(high, mode));
  const range = high - low;
  const mu    = (low + 4 * m + high) / 6;
  const α1    = 1 + 4 * (mu - low)  / range;
  const α2    = 1 + 4 * (high - mu) / range;
  return low + betaRand(α1, α2) * range;
}

/**
 * Samples an ANNUALISED expected return for one asset for one Monte Carlo path.
 *
 * Inputs are analyst PRICE targets (IDR).  The implied return is:
 *   μᵢ = (sampled_price_i − current_price_i) / current_price_i + dividend yield
 *
 * Analyst targets are 12-month forward prices, so this return is implicitly
 * annualised and directly comparable to the 5.75% BI risk-free rate.
 *
 * @param {Asset} asset
 * @returns {number}  annualised decimal return (e.g. 0.14 = +14%)
 */
function samplePertViewReturn(asset) {
  const px  = asset.meta.currentPrice;
  const fe  = asset.forwardEstimates;
  if (!px || px <= 0) return 0;

  const low  = Math.min(fe.lowTarget, fe.meanTarget, fe.highTarget);
  const high = Math.max(fe.lowTarget, fe.meanTarget, fe.highTarget);
  const mode = Math.max(low, Math.min(high, fe.meanTarget));

  const sampledPrice = pertSample(low, mode, high);
  return (sampledPrice - px) / px + dividendYield(asset);
}

function buildConstraintOpts(sectorCaps, maxPositionCap, positionCaps) {
  return { sectorCaps, maxPositionCap, positionCaps };
}

function capForAsset(i, maxPositionCap, positionCaps) {
  const cap = positionCaps?.[i] ?? maxPositionCap;
  return Math.max(cap, 0);
}

function hasBindingPositionCaps(maxPositionCap, positionCaps) {
  if (positionCaps?.length) return positionCaps.some(c => c < 1 - 1e-8);
  return maxPositionCap < 1 - 1e-8;
}

// ── Dirichlet Weight Generation  ───────────────────────────────────────────────

function dirichletWeights(n) {
  const raw = Array.from({ length: n }, () => -Math.log(Math.random() + 1e-15));
  const sum = raw.reduce((s, v) => s + v, 0);
  return raw.map(v => v / sum);
}

// ── Linear Algebra (small n)  ─────────────────────────────────────────────────

/** In-place Gauss-Jordan inversion of an n×n matrix. Returns null if singular. */
function invertMatrix(matrix) {
  const n = matrix.length;
  const aug = matrix.map((row, i) => {
    const identity = Array(n).fill(0);
    identity[i] = 1;
    return [...row, ...identity];
  });

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[pivot][col])) pivot = row;
    }
    if (Math.abs(aug[pivot][col]) < 1e-12) return null;

    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    const div = aug[col][col];
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= div;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      if (Math.abs(factor) < 1e-15) continue;
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  return aug.map(row => row.slice(n));
}

function matVecMul(matrix, vec) {
  return matrix.map(row => row.reduce((s, v, j) => s + v * vec[j], 0));
}

/** Unconstrained tangency portfolio: w ∝ Σ⁻¹(μ − r_f·1), normalised. */
function tangencyWeights(means, covMatrix, riskFreeRate, invSigma = null) {
  const inv = invSigma ?? invertMatrix(covMatrix);
  if (!inv) return null;
  const raw = matVecMul(inv, means.map(m => m - riskFreeRate));
  const sum = raw.reduce((s, v) => s + v, 0);
  if (Math.abs(sum) < 1e-12) return null;
  return raw.map(v => v / sum);
}

/** Long-only normalisation of a raw weight vector (fallback: equal weight). */
function longOnlyNormalise(raw, n) {
  const pos = raw.map(v => Math.max(0, v));
  const sum = pos.reduce((s, v) => s + v, 0);
  return sum > 1e-12 ? pos.map(v => v / sum) : Array(n).fill(1 / n);
}

/**
 * Fast per-scenario max-Sharpe seed: tangency → long-only clip → cap enforcement.
 * Used for every MC path; the global best gets a heavy hill-climb refine.
 */
function fastMaxSharpeWeights(means, invSigma, assets, constraintOpts, riskFreeRate) {
  const n = assets.length;
  if (!invSigma) {
    return enforcePortfolioConstraints(Array(n).fill(1 / n), assets, constraintOpts);
  }
  const tangency = tangencyWeights(means, null, riskFreeRate, invSigma);
  const seed = tangency ? longOnlyNormalise(tangency, n) : Array(n).fill(1 / n);
  return enforcePortfolioConstraints(seed, assets, constraintOpts);
}

// ── Constrained Portfolio Optimisation  ───────────────────────────────────────

function portfolioMetrics(weights, means, covMatrix, riskFreeRate) {
  const ret = portfolioReturn(weights, means);
  const variance = portfolioVariance(weights, covMatrix);
  const risk = Math.sqrt(variance);
  return {
    portfolioReturn: ret,
    portfolioVariance: variance,
    portfolioRisk: risk,
    portfolioSharpe: sharpeRatio(ret, risk, riskFreeRate),
  };
}


function averageScenarioMeans(scenarios) {
  const n = scenarios[0].length;
  const avg = Array(n).fill(0);
  for (const means of scenarios) {
    for (let i = 0; i < n; i++) avg[i] += means[i];
  }
  return avg.map(v => v / scenarios.length);
}

/**
 * Hill-climbing optimiser on the capped simplex.
 * Transfers weight between asset pairs; re-enforces caps after each move.
 */
function optimizePortfolio(objective, assets, constraintOpts, startWeights, { maxIter = 120, step = 0.008, randomRestarts = 32, extraStarts = [] } = {}) {
  const n = assets.length;
  const starts = [startWeights, ...extraStarts];
  for (let r = 0; r < randomRestarts; r++) {
    starts.push(dirichletWeights(n));
  }

  let bestW = enforcePortfolioConstraints(Array(n).fill(1 / n), assets, constraintOpts);
  let bestScore = objective(bestW);

  for (const seed of starts) {
    let w = enforcePortfolioConstraints(seed, assets, constraintOpts);
    let score = objective(w);

    for (let iter = 0; iter < maxIter; iter++) {
      let improved = false;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const delta = Math.min(step, w[i]);
          if (delta < 1e-8) continue;
          const trial = enforcePortfolioConstraints(
            w.map((v, k) => (k === i ? v - delta : k === j ? v + delta : v)),
            assets,
            constraintOpts,
          );
          const trialScore = objective(trial);
          if (trialScore > score + 1e-10) {
            w = trial;
            score = trialScore;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }

    if (score > bestScore) {
      bestScore = score;
      bestW = w;
    }
  }

  return {
    weights: enforcePortfolioConstraints(bestW, assets, constraintOpts),
    score: bestScore,
  };
}

/**
 * Finds the robust portfolio under a given objective mode.
 *
 * @param {number[][]} scenarios       — all MC paths
 * @param {number[][]} covMatrix
 * @param {Asset[]}    assets
 * @param {{
 *   sectorCaps, maxPositionCap, positionCaps, riskFreeRate,
 *   robustMode?:      'tailAware' | 'avgMuSharpe',
 *   tailPenalty?:     number,
 *   currentWeights?:  number[]|null,
 *   turnoverPenalty?: number,
 *   choleskyL?:        number[][],   — shared Cholesky factor (reuse across λ sweep)
 *   subIdx?:           number[],     — fixed subsample indices (reuse across λ sweep)
 *   realizationShocks?: number[][], — fixed correlated shocks for subIdx paths
 *   randomRestarts?:   number,
 * }} opts
 */
function findRobustPortfolio(scenarios, covMatrix, assets, opts) {
  const {
    sectorCaps, maxPositionCap, positionCaps, riskFreeRate,
    robustMode = 'tailAware',
    tailPenalty = DEFAULT_TAIL_PENALTY,
    currentWeights = null,
    turnoverPenalty = 0,
    choleskyL: sharedCholesky = null,
    subIdx: sharedSubIdx = null,
    realizationShocks: sharedShocks = null,
    randomRestarts = 32,
    startWeights = null,
    deterministicStarts = false,
  } = opts;

  const constraintOpts = buildConstraintOpts(sectorCaps, maxPositionCap, positionCaps);
  const n = assets.length;

  const subIdx = sharedSubIdx ?? pickEvenlySpacedIndices(
    scenarios.length, Math.min(scenarios.length, ROBUST_SUBSAMPLE_SIZE),
  );
  const subsampleScenarios = subIdx.map(i => scenarios[i]);
  const avgMeans = averageScenarioMeans(subsampleScenarios);

  const eqW = Array(n).fill(1 / n);
  const sigmaRef = Math.sqrt(portfolioVariance(eqW, covMatrix));

  const choleskyL = sharedCholesky ?? choleskyDecompose(covMatrix);
  const realizationShocks = sharedShocks ?? drawCorrelatedShocks(choleskyL, subsampleScenarios.length);

  const objective = buildObjectiveFn({
    mode: robustMode,
    subsampleScenarios,
    avgMeans,
    covMatrix,
    riskFreeRate,
    tailPenalty,
    sigmaRef,
    currentWeights,
    turnoverPenalty,
    realizationShocks,
  });

  const tangency = tangencyWeights(avgMeans, covMatrix, riskFreeRate);
  const defaultSeed = tangency ?? Array(n).fill(1 / n);
  const seed = startWeights ?? defaultSeed;

  const extraStarts = deterministicStarts
    ? buildDeterministicSeeds(assets, constraintOpts, avgMeans, covMatrix, riskFreeRate)
    : (startWeights ? [defaultSeed] : []);
  const restarts = deterministicStarts ? 0 : randomRestarts;

  const { weights, score } = optimizePortfolio(objective, assets, constraintOpts, seed, {
    maxIter: 100, step: 0.01, randomRestarts: restarts,
    extraStarts,
  });

  // Report avgMeans across the full set for display purposes
  const fullAvgMeans = averageScenarioMeans(scenarios);
  const metrics = portfolioMetrics(weights, fullAvgMeans, covMatrix, riskFreeRate);
  return { weights, avgMeans: fullAvgMeans, portfolioSharpe: metrics.portfolioSharpe };
}

/**
 * Builds the Consensus portfolio: max Sharpe on the single consensus return
 * vector (BL posterior mean or PERT mean). Directly investable reference.
 */
function findConsensusPortfolio(assets, covMatrix, opts, blContext, simCov, deterministicStarts = false) {
  const { sectorCaps, maxPositionCap, positionCaps, riskFreeRate } = opts;
  const constraintOpts = buildConstraintOpts(sectorCaps, maxPositionCap, positionCaps);
  const n = assets.length;

  let means;
  if (blContext) {
    // BL posterior on mean PERT views
    const Q = assets.map(a => {
      const px  = a.meta.currentPrice;
      const fe  = a.forwardEstimates;
      if (!px || px <= 0) return 0;
      const div = a.meta?.dividendYield ?? 0;
      return (fe.meanTarget - px) / px + div;
    });
    const covForBL = simCov ?? covMatrix;
    means = computePosteriorReturns(Q, covForBL, blContext);
  } else {
    means = assets.map(a => {
      const px  = a.meta.currentPrice;
      const fe  = a.forwardEstimates;
      if (!px || px <= 0) return 0;
      const div = a.meta?.dividendYield ?? 0;
      return (fe.meanTarget - px) / px + div;
    });
  }

  const objective = (w) => {
    const risk = Math.sqrt(portfolioVariance(w, covMatrix));
    return sharpeRatio(portfolioReturn(w, means), risk, riskFreeRate);
  };

  const tangency = tangencyWeights(means, covMatrix, riskFreeRate);
  const seed = tangency ?? Array(n).fill(1 / n);
  const extraStarts = deterministicStarts
    ? buildDeterministicSeeds(assets, constraintOpts, means, covMatrix, riskFreeRate)
    : [];
  const restarts = deterministicStarts ? 0 : 24;
  const { weights, score } = optimizePortfolio(objective, assets, constraintOpts, seed, {
    maxIter: 100, step: 0.01, randomRestarts: restarts,
    extraStarts,
  });

  const metrics = portfolioMetrics(weights, means, covMatrix, riskFreeRate);
  return {
    weights,
    portfolioReturn: metrics.portfolioReturn,
    portfolioRisk: metrics.portfolioRisk,
    portfolioSharpe: metrics.portfolioSharpe,
    pertMeans: means,
  };
}

/** Max-Sharpe weights for one analyst scenario μ (constrained). */
function findMaxSharpeForScenario(means, covMatrix, assets, { sectorCaps, maxPositionCap, positionCaps, riskFreeRate }, { heavy = false } = {}) {
  const n = assets.length;
  const constraintOpts = buildConstraintOpts(sectorCaps, maxPositionCap, positionCaps);
  const objective = (w) => {
    const risk = Math.sqrt(portfolioVariance(w, covMatrix));
    return sharpeRatio(portfolioReturn(w, means), risk, riskFreeRate);
  };

  const tangency = tangencyWeights(means, covMatrix, riskFreeRate);
  const seed = tangency ?? Array(n).fill(1 / n);

  return optimizePortfolio(objective, assets, constraintOpts, seed, heavy
    ? { maxIter: 100, step: 0.01, randomRestarts: 32 }
    : { maxIter: 55, step: 0.012, randomRestarts: 6 },
  );
}

/**
 * Per-scenario optimal portfolios for chart subsample; scans all paths for oracle best.
 */
function computeScenarioOptima(scenarios, covMatrix, assets, opts) {
  const invSigma = invertMatrix(covMatrix);
  const constraintOpts = buildConstraintOpts(opts.sectorCaps, opts.maxPositionCap, opts.positionCaps);
  const chartIndices = pickEvenlySpacedIndices(
    scenarios.length, Math.min(scenarios.length, CHART_MAX_POINTS),
  );
  const chartIndexSet = new Set(chartIndices);
  const scenarioOptima = [];

  let bestSharpe = -Infinity;
  let bestIdx = -1;
  let bestWeights = null;
  let bestMetrics = null;

  for (let i = 0; i < scenarios.length; i++) {
    const means = scenarios[i];
    const weights = fastMaxSharpeWeights(means, invSigma, assets, constraintOpts, opts.riskFreeRate);
    const metrics = portfolioMetrics(weights, means, covMatrix, opts.riskFreeRate);

    if (chartIndexSet.has(i)) {
      scenarioOptima.push({
        portfolioReturn: metrics.portfolioReturn,
        portfolioRisk: metrics.portfolioRisk,
        portfolioSharpe: metrics.portfolioSharpe,
      });
    }

    if (metrics.portfolioSharpe > bestSharpe) {
      bestSharpe = metrics.portfolioSharpe;
      bestIdx = i;
      bestWeights = weights;
      bestMetrics = metrics;
    }
  }

  let bestSharpePortfolio = {
    weights: bestWeights,
    portfolioReturn: bestMetrics.portfolioReturn,
    portfolioRisk: bestMetrics.portfolioRisk,
    portfolioSharpe: bestMetrics.portfolioSharpe,
    pertMeans: scenarios[bestIdx],
  };

  // Heavy refinement on the winning scenario for accurate analytics weights
  if (bestIdx >= 0) {
    const means = scenarios[bestIdx];
    const { weights, score } = findMaxSharpeForScenario(
      means, covMatrix, assets, opts, { heavy: true },
    );
    if (score > bestSharpe) {
      const metrics = portfolioMetrics(weights, means, covMatrix, opts.riskFreeRate);
      bestSharpePortfolio = {
        weights,
        portfolioReturn: metrics.portfolioReturn,
        portfolioRisk: metrics.portfolioRisk,
        portfolioSharpe: metrics.portfolioSharpe,
        pertMeans: means,
      };
    }
  }

  return { scenarioOptima, bestSharpePortfolio, optimaComputed: chartIndices.length };
}

/** Robust fixed weights evaluated on a chart subsample of scenarios. */
function buildRobustChartCloud(scenarios, weights, covMatrix, riskFreeRate, maxPoints) {
  const risk = Math.sqrt(portfolioVariance(weights, covMatrix));
  const indices = pickEvenlySpacedIndices(scenarios.length, Math.min(scenarios.length, maxPoints));
  return indices.map(i => {
    const pertMeans = scenarios[i];
    const ret = portfolioReturn(weights, pertMeans);
    return {
      weights,
      portfolioReturn: ret,
      portfolioRisk: risk,
      portfolioSharpe: sharpeRatio(ret, risk, riskFreeRate),
      pertMeans,
    };
  });
}

function findMinVariancePortfolio(covMatrix, assets, { sectorCaps, maxPositionCap, positionCaps }, deterministicStarts = false) {
  const n = assets.length;
  const constraintOpts = buildConstraintOpts(sectorCaps, maxPositionCap, positionCaps);

  const objective = (w) => -portfolioVariance(w, covMatrix);

  const inv = invertMatrix(covMatrix);
  let seed = Array(n).fill(1 / n);
  if (inv) {
    const ones = Array(n).fill(1);
    const raw = matVecMul(inv, ones);
    const sum = raw.reduce((s, v) => s + v, 0);
    if (Math.abs(sum) > 1e-12) seed = raw.map(v => v / sum);
  }

  const { weights } = optimizePortfolio(
    objective,
    assets,
    constraintOpts,
    seed,
    { maxIter: 100, step: 0.01, randomRestarts: deterministicStarts ? 0 : 24 },
  );

  return weights;
}

/**
 * Builds a set of deterministic starting portfolios covering cap-boundary vertices.
 * Used instead of random Dirichlet restarts when deterministicStarts = true.
 *
 * Returns 3 + n_capped + |sectors_capped| seeds:
 *   1. Tangency (interior optimum for Sharpe term)
 *   2. Equal weight (neutral center)
 *   3. Min-variance analytical seed (Σ⁻¹·1 normalised)
 *   4. Per-asset cap-corner: asset i at its cap, rest equal
 *   5. Per-sector cap-corner: sector at its cap, equal within sector and outside
 */
function buildDeterministicSeeds(assets, constraintOpts, means, covMatrix, riskFreeRate) {
  const n = assets.length;
  const { maxPositionCap, positionCaps, sectorCaps } = constraintOpts;
  const seeds = [];

  // 1. Tangency — interior optimum for Sharpe term
  const tang = tangencyWeights(means, covMatrix, riskFreeRate);
  if (tang) seeds.push(tang);

  // 2. Equal weight
  seeds.push(Array(n).fill(1 / n));

  // 3. Min-variance analytical seed (Σ⁻¹·1 normalised)
  const inv = invertMatrix(covMatrix);
  if (inv) {
    const ones = Array(n).fill(1);
    const raw = matVecMul(inv, ones);
    const s = raw.reduce((a, v) => a + v, 0);
    if (Math.abs(s) > 1e-12) seeds.push(raw.map(v => v / s));
  }

  // 4. Per-asset cap-corner: asset i at its position cap, remainder equal across others
  for (let i = 0; i < n; i++) {
    const cap = positionCaps?.[i] ?? maxPositionCap;
    if (cap >= 1 - 1e-8) continue; // no binding cap — skip
    const remainder = (1 - cap) / Math.max(1, n - 1);
    const w = Array(n).fill(remainder);
    w[i] = cap;
    seeds.push(w);
  }

  // 5. Per-sector cap-corner: sector at its cap (equal within), remainder equal outside
  const sectorGroups = {};
  assets.forEach((a, i) => {
    if (!sectorGroups[a.sector]) sectorGroups[a.sector] = [];
    sectorGroups[a.sector].push(i);
  });
  for (const [sector, indices] of Object.entries(sectorGroups)) {
    const cap = resolveSectorCap(sectorCaps, sector);
    if (cap >= 1 - 1e-8) continue; // no binding sector cap — skip
    const outside = n - indices.length;
    const w = Array(n).fill(0);
    indices.forEach(i => { w[i] = cap / indices.length; });
    if (outside > 0) {
      const outsideShare = (1 - cap) / outside;
      w.forEach((_, idx) => { if (!indices.includes(idx)) w[idx] = outsideShare; });
    }
    seeds.push(w);
  }

  // Enforce caps on every seed before returning
  return seeds.map(s => enforcePortfolioConstraints(s, assets, constraintOpts));
}

function computeScenarioStats(weights, scenarios, covMatrix, riskFreeRate, choleskyL = null, predrawnShocks = null) {
  const L = choleskyL ?? choleskyDecompose(covMatrix);
  const sigDiag = covDiag(covMatrix);
  const shockMatrix = predrawnShocks ?? drawCorrelatedShocks(L, scenarios.length);
  const portfolioReturns = computeRealizedPortfolioReturns(weights, scenarios, shockMatrix, sigDiag);
  const tail = computeTailMetrics(portfolioReturns, riskFreeRate);

  return {
    returnP10:   tail.returnP10,
    returnP50:   tail.returnP50,
    returnP90:   tail.returnP90,
    cvar5:       tail.cvar5,
    tailGap:     tail.tailGap,
    probBelowRf: tail.probBelowRf,
  };
}

// ── Sector Constraint Enforcement  ───────────────────────────────────────────

/** Remaining capacity for a sector before hitting its cap. */
function sectorHeadroom(indices, w, cap) {
  const sum = indices.reduce((s, i) => s + w[i], 0);
  return Math.max(0, cap - sum);
}

/** Remaining capacity for a single position before hitting its cap. */
function positionHeadroom(i, w, maxPositionCap, positionCaps) {
  return Math.max(0, capForAsset(i, maxPositionCap, positionCaps) - w[i]);
}

/**
 * Adds `amount` of weight across assets that still have headroom under both
 * the per-position cap and their sector cap. Returns unplaced weight.
 */
function allocateByAssetHeadroom(w, assets, sectorGroups, sectorCaps, maxPositionCap, positionCaps, amount, skipIndices = new Set()) {
  if (amount <= 1e-12) return amount;

  const capFor = (sector) => resolveSectorCap(sectorCaps, sector);
  const candidates = [];

  for (let i = 0; i < w.length; i++) {
    if (skipIndices.has(i)) continue;
    const posRoom = positionHeadroom(i, w, maxPositionCap, positionCaps);
    if (posRoom <= 1e-12) continue;
    candidates.push({ i, sector: assets[i].sector, posRoom });
  }

  if (candidates.length === 0) return amount;

  const sectorRoom = {};
  for (const [sector, indices] of Object.entries(sectorGroups)) {
    sectorRoom[sector] = sectorHeadroom(indices, w, capFor(sector));
  }

  const bySector = {};
  for (const c of candidates) {
    if (!bySector[c.sector]) bySector[c.sector] = [];
    bySector[c.sector].push(c);
  }

  let totalEffectiveRoom = 0;
  const effective = [];
  for (const [sector, group] of Object.entries(bySector)) {
    const sRoom = sectorRoom[sector];
    if (sRoom <= 1e-12) continue;
    const posSum = group.reduce((s, c) => s + c.posRoom, 0);
    for (const c of group) {
      const room = Math.min(c.posRoom, (c.posRoom / posSum) * sRoom);
      if (room > 1e-12) {
        effective.push({ i: c.i, room });
        totalEffectiveRoom += room;
      }
    }
  }

  if (totalEffectiveRoom <= 1e-12) return amount;

  const placed = Math.min(amount, totalEffectiveRoom);
  for (const { i, room } of effective) {
    w[i] += (room / totalEffectiveRoom) * placed;
  }
  return amount - placed;
}

/**
 * Adds `amount` of weight across sectors that still have headroom below their cap.
 * Returns weight that could not be placed (no headroom left).
 */
function allocateByHeadroom(w, sectorGroups, capFor, maxPositionCap, positionCaps, amount, skipSectors = new Set(), assets = null) {
  if (amount <= 1e-12) return 0;

  if (assets && hasBindingPositionCaps(maxPositionCap, positionCaps)) {
    return allocateByAssetHeadroom(w, assets, sectorGroups, Object.fromEntries(
      Object.keys(sectorGroups).map(s => [s, capFor(s)])
    ), maxPositionCap, positionCaps, amount, new Set());
  }

  const buckets = [];
  for (const [sector, indices] of Object.entries(sectorGroups)) {
    if (skipSectors.has(sector)) continue;
    const room = sectorHeadroom(indices, w, capFor(sector));
    if (room > 1e-12) buckets.push({ indices, room });
  }

  const totalRoom = buckets.reduce((s, b) => s + b.room, 0);
  if (totalRoom <= 1e-12) return amount;

  const placed = Math.min(amount, totalRoom);
  for (const { indices, room } of buckets) {
    const share = (room / totalRoom) * placed;
    const idxSum = indices.reduce((s, i) => s + w[i], 0);
    if (idxSum > 1e-12) {
      indices.forEach(i => { w[i] += share * (w[i] / idxSum); });
    } else {
      indices.forEach(i => { w[i] += share / indices.length; });
    }
  }
  return amount - placed;
}

/**
 * Enforces sector and per-position caps while targeting a fully invested portfolio (weights sum ≈ 1).
 *
 * 1. Clip overweight positions to maxPositionCap.
 * 2. Clip overweight sectors to their cap.
 * 3. Redistribute freed weight into assets/sectors with remaining headroom.
 * 4. If total weight is below 1, top up using available headroom.
 *
 * @param {number[]} weights
 * @param {Asset[]}  assets
 * @param {Object}   [options]
 * @param {Object}   [options.sectorCaps={}]
 * @param {number}   [options.maxPositionCap=1]  — max weight per single stock (1 = no cap)
 * @param {number[]} [options.positionCaps]        — per-asset caps (overrides maxPositionCap per index)
 * @param {number}   [options.maxIter=40]
 * @returns {number[]} weights summing to ~1
 */
function enforcePortfolioConstraints(weights, assets, { sectorCaps = {}, maxPositionCap = 1, positionCaps = null, maxIter = 40 } = {}) {
  let w = [...weights];

  const sectorGroups = {};
  assets.forEach((a, i) => {
    if (!sectorGroups[a.sector]) sectorGroups[a.sector] = [];
    sectorGroups[a.sector].push(i);
  });

  const capFor = (sector) => resolveSectorCap(sectorCaps, sector);
  const sumSector = (indices) => indices.reduce((s, i) => s + w[i], 0);
  const totalW = () => w.reduce((s, v) => s + v, 0);
  const hasPositionCap = hasBindingPositionCaps(maxPositionCap, positionCaps);
  const hasSectorCaps = sectorCapsBind(sectorGroups, sectorCaps);

  const redistributeExcess = (excess, skipIndices, skipSectors) => {
    if (excess <= 1e-12) return;
    if (hasPositionCap) {
      allocateByAssetHeadroom(
        w, assets, sectorGroups, sectorCaps, maxPositionCap, positionCaps, excess, skipIndices,
      );
    } else {
      allocateByHeadroom(w, sectorGroups, capFor, maxPositionCap, positionCaps, excess, skipSectors, assets);
    }
  };

  const clipPositions = () => {
    if (!hasPositionCap) return false;
    let changed = false;
    for (let i = 0; i < w.length; i++) {
      const cap = capForAsset(i, maxPositionCap, positionCaps);
      if (w[i] > cap + 1e-8) {
        changed = true;
        const excess = w[i] - cap;
        w[i] = cap;
        redistributeExcess(excess, new Set([i]), new Set());
      }
    }
    return changed;
  };

  // No binding caps — normalise to 100%.
  if (!hasSectorCaps && !hasPositionCap) {
    const total = totalW();
    return total > 1e-10 ? w.map(v => Math.max(0, v / total)) : w;
  }

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = clipPositions();

    if (hasSectorCaps) {
      for (const [sector, indices] of Object.entries(sectorGroups)) {
        const cap = capFor(sector);
        const sectorSum = sumSector(indices);

        if (sectorSum > cap + 1e-8) {
          changed = true;
          const excess = sectorSum - cap;
          indices.forEach(i => { w[i] *= cap / sectorSum; });
          redistributeExcess(excess, new Set(indices), new Set([sector]));
        }
      }
    }

    let total = totalW();
    if (total > 1 + 1e-8) {
      changed = true;
      w = w.map(v => v / total);
    } else {
      const deficit = 1 - total;
      if (deficit > 1e-8) {
        const leftover = hasPositionCap
          ? allocateByAssetHeadroom(w, assets, sectorGroups, sectorCaps, maxPositionCap, positionCaps, deficit)
          : allocateByHeadroom(w, sectorGroups, capFor, maxPositionCap, positionCaps, deficit, new Set(), assets);
        if (leftover < deficit - 1e-8) changed = true;
      }
    }

    if (!changed) break;
  }

  // Final clip + top-up passes
  for (let pass = 0; pass < 8; pass++) {
    let clipped = clipPositions();

    if (hasSectorCaps) {
      for (const [sector, indices] of Object.entries(sectorGroups)) {
        const cap = capFor(sector);
        const sectorSum = sumSector(indices);
        if (sectorSum > cap + 1e-8) {
          clipped = true;
          const excess = sectorSum - cap;
          indices.forEach(i => { w[i] *= cap / sectorSum; });
          redistributeExcess(excess, new Set(indices), new Set([sector]));
        }
      }
    }

    const total = totalW();
    if (total > 1 + 1e-8) {
      clipped = true;
      w = w.map(v => v / total);
    } else {
      const deficit = 1 - total;
      if (deficit > 1e-8) {
        if (hasPositionCap) {
          allocateByAssetHeadroom(w, assets, sectorGroups, sectorCaps, maxPositionCap, positionCaps, deficit);
        } else {
          allocateByHeadroom(w, sectorGroups, capFor, maxPositionCap, positionCaps, deficit, new Set(), assets);
        }
      }
    }
    if (!clipped && Math.abs(totalW() - 1) < 1e-6) break;
  }

  return w.map(v => Math.max(0, v));
}

// ── Monte Carlo Simulation  ───────────────────────────────────────────────────

/** λ values swept for the robustness frontier overlay. */
const FRONTIER_LAMBDAS = [0, 0.10, 0.20, 0.35, 0.50, 0.75, 1.0];

/**
 * Builds the scenario bank: samples all PERT/BL paths, computes Cholesky,
 * optimizer subsample + shocks, and full-set reporting shocks.
 *
 * Called once per distinct (snapshot, corrWindow, factorConfig, mcIterations, ...) tuple.
 * The bank is reused across REGENERATE clicks so optimizer inputs stay fixed and weights
 * are stable at a given λ.
 *
 * @returns {{ scenarios, choleskyL, robustSubIdx, robustShocks, reportingShocks,
 *             simCov, blContext, autoPositionCaps, factorActive }}
 */
export function buildScenarioBank({
  assets,
  covMatrix,
  factorConfig     = null,
  iterations       = 100000,
  optimizerPaths   = ROBUST_SUBSAMPLE_SIZE,
  riskFreeRate     = 0.0575,
  maxPositionCap   = 1,
  userPositionCaps = {},
}) {
  const cfg = normalizeFactorConfig(factorConfig ?? {});
  const factorActive = isFactorModelActive(cfg);

  let simCov = covMatrix;
  let autoPositionCaps = null;
  let blContext = null;

  if (factorActive) {
    const { effectiveConfig: effectiveCfg, positionCaps: portfolioCaps } = resolvePortfolioLiquidity(
      assets, cfg, maxPositionCap,
    );
    const factors = computeQualityFactors(assets, effectiveCfg);
    simCov = augmentCovarianceMatrix(covMatrix, factors.perAsset, effectiveCfg);
    autoPositionCaps = portfolioCaps;

    if (shouldUseBlackLitterman(cfg)) {
      blContext = buildBlackLittermanContext({
        assets,
        covMatrix: simCov,
        capWeights: factors.capWeights,
        factorConfig: cfg,
        maxAnalysts: factors.maxAnalysts,
        riskFreeRate,
      });
    }
  }

  const sampleScenario = () => {
    if (!factorActive || !shouldUseBlackLitterman(cfg) || !blContext) {
      return assets.map(samplePertViewReturn);
    }
    const Q = assets.map(samplePertViewReturn);
    return computePosteriorReturns(Q, simCov, blContext);
  };

  const scenarios = Array.from({ length: iterations }, () => sampleScenario());

  const choleskyL = choleskyDecompose(simCov);
  const robustSubIdx = pickEvenlySpacedIndices(
    scenarios.length, Math.min(scenarios.length, Math.max(1, optimizerPaths)),
  );
  const robustShocks    = drawCorrelatedShocks(choleskyL, robustSubIdx.length);
  const reportingShocks = drawCorrelatedShocks(choleskyL, scenarios.length);

  return {
    scenarios,
    choleskyL,
    robustSubIdx,
    robustShocks,
    reportingShocks,
    simCov,
    blContext,
    autoPositionCaps,
    factorActive,
  };
}

export function runMonteCarloSimulation({
  assets,
  covMatrix,
  sectorCaps          = {},
  maxPositionCap      = 1,
  riskFreeRate        = 0.0575,
  iterations          = 100000,
  factorConfig        = null,
  // Robust options
  robustMode          = 'tailAware',
  tailPenalty         = DEFAULT_TAIL_PENALTY,
  currentWeights      = null,
  turnoverPenalty     = 0,
  userPositionCaps    = {},
  // Bank + optimizer options
  prebuiltBank        = null,
  deterministicStarts = false,
  optimizerPaths      = ROBUST_SUBSAMPLE_SIZE,
}) {
  const n = assets.length;
  const empty = {
    portfolios: [],
    scenarioOptima: [],
    robustPortfolio: null,
    consensusPortfolio: null,
    bestSharpePortfolio: null,
    minVariancePortfolio: null,
    stressResults: [],
    frontierPoints: [],
    meta: { totalScenarios: 0, chartPoints: 0, optimaComputed: 0 },
  };
  if (n < 2) return empty;

  // ── Phase 1: build or reuse scenario bank ─────────────────────────────────
  // When prebuiltBank is provided (same snapshot/corr/factorConfig), scenarios and
  // shocks are reused exactly — optimizer sees the same objective surface every click.
  const bank = prebuiltBank ?? buildScenarioBank({
    assets, covMatrix, factorConfig, iterations, optimizerPaths,
    riskFreeRate, maxPositionCap, userPositionCaps,
  });
  const {
    scenarios, simCov, blContext, choleskyL,
    robustSubIdx, robustShocks, reportingShocks, autoPositionCaps, factorActive,
  } = bank;

  // Merge user position caps fresh — not stored in bank so assetMaxWeights changes
  // don't require a bank rebuild.
  const positionCaps = mergePositionCaps(assets, maxPositionCap, autoPositionCaps ?? null, userPositionCaps);

  const opt = { sectorCaps, maxPositionCap, positionCaps, riskFreeRate };

  const sharedRobustResources = {
    choleskyL,
    subIdx: robustSubIdx,
    realizationShocks: robustShocks,
  };

  // ── Phase 2: tail-aware robust portfolio ───────────────────────────────────
  const robustOpts = {
    ...opt,
    robustMode,
    tailPenalty,
    currentWeights,
    turnoverPenalty,
    deterministicStarts,
    ...sharedRobustResources,
  };
  const { weights: robustWeights, avgMeans, portfolioSharpe: robustSharpe } = findRobustPortfolio(
    scenarios, simCov, assets, robustOpts,
  );
  const robustMetrics = portfolioMetrics(robustWeights, avgMeans, simCov, riskFreeRate);

  const robustPortfolio = {
    weights: robustWeights,
    portfolioReturn: robustMetrics.portfolioReturn,
    portfolioRisk: robustMetrics.portfolioRisk,
    portfolioSharpe: robustSharpe,
    pertMeans: avgMeans,
    scenarioStats: null, // filled in below
  };

  // ── Phase 3: per-scenario optima (subsampled) + oracle best Sharpe ─────────
  const { scenarioOptima, bestSharpePortfolio, optimaComputed } = computeScenarioOptima(
    scenarios, simCov, assets, opt,
  );

  // ── Phase 4: consensus portfolio (implementable reference) ────────────────
  const consensusPortfolio = findConsensusPortfolio(assets, simCov, opt, blContext, simCov, deterministicStarts);

  // ── Phase 5: min-variance on Σ ────────────────────────────────────────────
  const mvpWeights = findMinVariancePortfolio(simCov, assets, { sectorCaps, maxPositionCap, positionCaps }, deterministicStarts);
  const mvpMetrics = portfolioMetrics(mvpWeights, avgMeans, simCov, riskFreeRate);
  const minVariancePortfolio = { weights: mvpWeights, ...mvpMetrics, pertMeans: avgMeans };

  // ── Phase 6: stress test results ──────────────────────────────────────────
  const stressResults = evaluateStressScenarios(assets, robustWeights);

  // ── Phase 7: robustness frontier sweep (λ levels, reuse scenarios) ─────────
  const frontierPoints = computeRobustnessFrontier(
    scenarios, simCov, assets, robustOpts, FRONTIER_LAMBDAS,
    { pinnedRobust: { weights: robustWeights, avgMeans, tailPenalty } },
  );

  // ── Phase 7.5: scenarioStats using the bank's pre-drawn reporting shocks ────
  // reportingShocks is fixed per bank so all λ rows are always comparable across
  // REGENERATE clicks on the same bank.
  const enrichedFrontierPoints = frontierPoints.map(fp => ({
    ...fp,
    scenarioStats: computeScenarioStats(fp.weights, scenarios, simCov, riskFreeRate, choleskyL, reportingShocks),
  }));

  const activePoint = enrichedFrontierPoints.find(fp => Math.abs(fp.lambda - tailPenalty) < 1e-8);
  robustPortfolio.scenarioStats = activePoint?.scenarioStats
    ?? computeScenarioStats(robustWeights, scenarios, simCov, riskFreeRate, choleskyL, reportingShocks);

  // ── Phase 8: chart clouds (subsampled — stats above use all scenarios) ─────
  const portfolios = buildRobustChartCloud(
    scenarios, robustWeights, simCov, riskFreeRate, CHART_MAX_POINTS,
  );
  const chartPoints = portfolios.length;

  return {
    portfolios,
    scenarioOptima,
    robustPortfolio,
    consensusPortfolio,
    bestSharpePortfolio,
    minVariancePortfolio,
    stressResults,
    frontierPoints: enrichedFrontierPoints,
    simCov,
    meta: {
      totalScenarios: iterations,
      chartPoints,
      optimaComputed,
      factorModelActive: factorActive ?? false,
      robustMode,
      tailPenalty,
    },
  };
}

// ── Stress test evaluation  ───────────────────────────────────────────────────

/**
 * Evaluates a fixed weight vector on deterministic PERT-bound scenarios.
 * No ML or history fitting — purely mechanical.
 */
export function evaluateStressScenarios(assets, weights) {
  const scenarios = [
    {
      name: 'All Mean',
      means: assets.map(a => {
        const px = a.meta.currentPrice;
        const fe = a.forwardEstimates;
        if (!px || px <= 0) return 0;
        return (fe.meanTarget - px) / px + (a.meta?.dividendYield ?? 0);
      }),
    },
    {
      name: 'All Low (Bear)',
      means: assets.map(a => {
        const px = a.meta.currentPrice;
        const fe = a.forwardEstimates;
        if (!px || px <= 0) return 0;
        const low = Math.min(fe.lowTarget ?? fe.meanTarget, fe.meanTarget, fe.highTarget ?? fe.meanTarget);
        return (low - px) / px + (a.meta?.dividendYield ?? 0);
      }),
    },
    {
      name: 'All High (Bull)',
      means: assets.map(a => {
        const px = a.meta.currentPrice;
        const fe = a.forwardEstimates;
        if (!px || px <= 0) return 0;
        const high = Math.max(fe.lowTarget ?? fe.meanTarget, fe.meanTarget, fe.highTarget ?? fe.meanTarget);
        return (high - px) / px + (a.meta?.dividendYield ?? 0);
      }),
    },
  ];

  // Per-sector downside: sector at low, rest at mean
  const sectors = [...new Set(assets.map(a => a.sector))];
  for (const sector of sectors) {
    const sectorAssets = assets.filter(a => a.sector === sector);
    if (sectorAssets.length < 2) continue;
    const means = assets.map(a => {
      const px = a.meta.currentPrice;
      const fe = a.forwardEstimates;
      if (!px || px <= 0) return 0;
      const div = a.meta?.dividendYield ?? 0;
      if (a.sector === sector) {
        const low = Math.min(fe.lowTarget ?? fe.meanTarget, fe.meanTarget, fe.highTarget ?? fe.meanTarget);
        return (low - px) / px + div;
      }
      return (fe.meanTarget - px) / px + div;
    });
    scenarios.push({ name: `${sector} Stress`, means });
  }

  const allMeanReturn = portfolioReturn(weights, scenarios[0].means);

  return scenarios.map(s => ({
    name: s.name,
    portfolioReturn: portfolioReturn(weights, s.means),
    vsMean: portfolioReturn(weights, s.means) - allMeanReturn,
  }));
}

// ── Robustness frontier sweep  ────────────────────────────────────────────────

/**
 * Sweeps λ values and re-optimises Robust weights for each.
 * Reuses scenarios and (when provided) shared shock/subsample resources.
 * The point at the active tailPenalty reuses pinnedRobust weights exactly.
 */
function computeRobustnessFrontier(scenarios, covMatrix, assets, baseOpts, lambdas, { pinnedRobust } = {}) {
  const activeLambda = pinnedRobust?.tailPenalty ?? baseOpts.tailPenalty;
  const resultsByLambda = new Map();

  if (pinnedRobust) {
    const { weights, avgMeans } = pinnedRobust;
    const risk = Math.sqrt(portfolioVariance(weights, covMatrix));
    const ret = portfolioReturn(weights, avgMeans);
    resultsByLambda.set(activeLambda, {
      lambda: activeLambda,
      portfolioReturn: ret,
      portfolioRisk: risk,
      portfolioSharpe: sharpeRatio(ret, risk, baseOpts.riskFreeRate),
      weights,
    });
  }

  const sweepLambdas = [...lambdas]
    .filter(lambda => !(pinnedRobust && Math.abs(lambda - activeLambda) < 1e-8))
    .sort((a, b) => a - b);

  let warmStart = pinnedRobust?.weights ?? null;

  for (const lambda of sweepLambdas) {
    const { weights, avgMeans } = findRobustPortfolio(scenarios, covMatrix, assets, {
      ...baseOpts,
      tailPenalty: lambda,
      randomRestarts: 8,
      startWeights: warmStart,
    });
    warmStart = weights;
    const risk = Math.sqrt(portfolioVariance(weights, covMatrix));
    const ret = portfolioReturn(weights, avgMeans);
    resultsByLambda.set(lambda, {
      lambda,
      portfolioReturn: ret,
      portfolioRisk: risk,
      portfolioSharpe: sharpeRatio(ret, risk, baseOpts.riskFreeRate),
      weights,
    });
  }

  return lambdas.map(lambda => resultsByLambda.get(lambda));
}
