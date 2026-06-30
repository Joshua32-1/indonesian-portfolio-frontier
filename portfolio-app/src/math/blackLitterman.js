/**
 * blackLitterman.js
 * Black-Litterman posterior returns with absolute views (P = I).
 */

import { isFactorModelActive } from './factorConfig.js';
import { computeDispersion } from './returns.js';

/** In-place Gauss-Jordan inversion. Returns null if singular. */
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

function scaleMatrix(matrix, scalar) {
  return matrix.map(row => row.map(v => v * scalar));
}

/** Default implied risk aversion from cap-weighted market excess return. */
export function defaultDelta(covMatrix, capWeights, riskFreeRate) {
  const n = covMatrix.length;
  const marketVar = capWeights.reduce(
    (s, wi, i) => s + wi * covMatrix[i].reduce((t, cov_ij, j) => t + cov_ij * capWeights[j], 0),
    0,
  );
  const marketReturn = 0.08 + riskFreeRate; // ~8% equity premium assumption
  const excess = marketReturn - riskFreeRate;
  return marketVar > 1e-12 ? excess / marketVar : 2.5;
}

/** Equilibrium returns π = δ Σ w_mkt. */
export function computeEquilibriumReturns(covMatrix, capWeights, { riskFreeRate = 0.0575, delta = null } = {}) {
  const d = delta ?? defaultDelta(covMatrix, capWeights, riskFreeRate);
  return matVecMul(covMatrix, capWeights).map(v => d * v);
}

/**
 * Equilibrium-prior reference weights under one of three modes. The ONLY thing that
 * varies the BL prior — everything downstream (π via δΣw, Ω, posterior) is unchanged.
 * Mirrors the backtester's buildStepContexts prior definitions exactly:
 *   'cap'    → the supplied cap-weight vector, returned UNCHANGED (byte-identical path)
 *   'equal'  → 1/n
 *   'shrunk' → 0.5·cap + 0.5·equal   (convex blend; still sums to 1 when cap does)
 *
 * @param {number[]} capWeights — the optimizer's cap-weight prior (sums to 1)
 * @param {'cap'|'shrunk'|'equal'} priorMode
 * @returns {number[]}
 */
export function applyPriorMode(capWeights, priorMode = 'cap') {
  if (priorMode === 'cap' || !priorMode) return capWeights; // unchanged ⇒ provably identical
  const n = capWeights.length;
  const eq = 1 / n;
  if (priorMode === 'equal') return Array(n).fill(eq);
  if (priorMode === 'shrunk') return capWeights.map(w => 0.5 * w + 0.5 * eq);
  throw new Error(`Unknown priorMode: ${priorMode}`);
}

/**
 * View uncertainty diagonal Ω — decoupled from τ so the τ slider actually moves μ_BL.
 *
 * ω_i = omegaScale · Σ_ii · (1 + dispersionOmega · dispersion_i)² · (maxAnalysts / analysts_i)^analystConfidence
 *
 * omegaScale is independent of τ. τ only enters blackLittermanPosterior via τΣ (the prior
 * precision side), so varying τ genuinely shifts the π-vs-Q blend without cancellation.
 *
 * IDX note: on average, analyst Q is ~1.5 annualised σ above π. omegaScale=0.05 combined
 * with τ=0.03 places μ_BL at roughly 40–45% toward Q for large-caps by default —
 * meaningful BL shrinkage from structurally optimistic sell-side targets.
 */
export function computeViewUncertainty(assets, covMatrix, factorConfig, maxAnalysts) {
  const cfg = factorConfig ?? {};
  const omegaScale = cfg.omegaScale ?? 0.05;  // decoupled from τ
  const dispScale = cfg.dispersionOmega ?? 0;
  const analystConf = cfg.analystConfidence ?? 0;

  return assets.map((asset, i) => {
    const dispersion = computeDispersion(asset);
    const analysts = Math.max(1, asset.forwardEstimates?.totalAnalysts ?? 1);
    const base = omegaScale * Math.max(covMatrix[i][i], 1e-10);
    const dispTerm = 1 + dispScale * dispersion;
    const coverageTerm = Math.pow(maxAnalysts / analysts, analystConf);
    return base * dispTerm * dispTerm * coverageTerm;
  });
}

/**
 * Black-Litterman posterior for absolute views (P = I).
 * μ_BL = [(τΣ)⁻¹ + Ω⁻¹]⁻¹ [(τΣ)⁻¹ π + Ω⁻¹ Q]
 */
export function blackLittermanPosterior({ pi, Q, omega, covMatrix, tau }) {
  const n = covMatrix.length;
  const tauSigma = scaleMatrix(covMatrix, tau);
  const tauSigmaInv = invertMatrix(tauSigma);
  if (!tauSigmaInv) return [...pi];

  const omegaInv = omega.map(w => (w > 1e-12 ? 1 / w : 1e12));

  const left = tauSigmaInv.map((row, i) =>
    row.map((v, j) => v + (i === j ? omegaInv[i] : 0)),
  );

  const leftInv = invertMatrix(left);
  if (!leftInv) return [...pi];

  const rhs = pi.map((_p, i) => {
    const fromPrior = tauSigmaInv[i].reduce((s, v, j) => s + v * pi[j], 0);
    const fromView = omegaInv[i] * Q[i];
    return fromPrior + fromView;
  });

  return matVecMul(leftInv, rhs);
}

/**
 * Build BL context for Monte Carlo: π, Ω, and precomputed posterior precision
 * so each path only applies the view-dependent Ω⁻¹Q term (no matrix inversion).
 */
export function buildBlackLittermanContext({
  assets,
  covMatrix,
  capWeights,
  factorConfig,
  maxAnalysts,
  riskFreeRate,
}) {
  const cfg = factorConfig ?? {};
  const pi = computeEquilibriumReturns(covMatrix, capWeights, { riskFreeRate });
  const omega = computeViewUncertainty(assets, covMatrix, cfg, maxAnalysts);
  const tau = cfg.tau ?? 0.05;
  const useViews = cfg.useAnalystViews !== false;

  if (!useViews) {
    return { pi, omega, tau, useViews, omegaInv: null, posteriorInv: null, priorPrecisionMu: null };
  }

  const tauSigma = scaleMatrix(covMatrix, tau);
  const tauSigmaInv = invertMatrix(tauSigma);
  if (!tauSigmaInv) {
    return { pi, omega, tau, useViews, omegaInv: null, posteriorInv: null, priorPrecisionMu: null };
  }

  const omegaInv = omega.map(w => (w > 1e-12 ? 1 / w : 1e12));
  const precision = tauSigmaInv.map((row, i) =>
    row.map((v, j) => v + (i === j ? omegaInv[i] : 0)),
  );
  const posteriorInv = invertMatrix(precision);
  if (!posteriorInv) {
    return { pi, omega, tau, useViews, omegaInv: null, posteriorInv: null, priorPrecisionMu: null };
  }

  const priorPrecisionMu = matVecMul(tauSigmaInv, pi);

  return { pi, omega, tau, useViews, omegaInv, posteriorInv, priorPrecisionMu };
}

/** Posterior μ for a single scenario view vector Q (fast path when context is precomputed). */
export function computePosteriorReturns(Q, covMatrix, blContext) {
  const { pi, omega, tau, useViews, omegaInv, posteriorInv, priorPrecisionMu } = blContext;
  if (!useViews) return [...pi];

  if (posteriorInv && priorPrecisionMu && omegaInv) {
    const rhs = priorPrecisionMu.map((v, i) => v + omegaInv[i] * Q[i]);
    return matVecMul(posteriorInv, rhs);
  }

  return blackLittermanPosterior({ pi, Q, omega, covMatrix, tau });
}

/** Whether BL should be used for this config. */
export function shouldUseBlackLitterman(factorConfig) {
  return isFactorModelActive(factorConfig) && factorConfig.useBlackLitterman !== false;
}
