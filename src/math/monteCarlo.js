/**
 * monteCarlo.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure mathematics module — no React, no side-effects.
 *
 * Implements a 5,500-iteration Monte Carlo portfolio simulation using:
 *   • Beta-PERT distribution for per-asset expected return sampling
 *   • Dirichlet(1,…,1) random weight generation — uniform on the unit simplex
 *   • Sector concentration caps with headroom-based redistribution
 *   • Portfolio return & variance computed against the pre-built Σ matrix
 *   • Sharpe ratio as the quality metric
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  portfolioReturn,
  portfolioVariance,
  sharpeRatio,
} from './matrixEngine.js';

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

export function pertSample(low, mode, high) {
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
 *   μᵢ = (sampled_price_i − current_price_i) / current_price_i
 *
 * Analyst targets are 12-month forward prices, so this return is implicitly
 * annualised and directly comparable to the 5.25% BI risk-free rate.
 *
 * @param {Asset} asset
 * @returns {number}  annualised decimal return (e.g. 0.14 = +14%)
 */
export function sampleAnalystReturn(asset) {
  const px  = asset.meta.currentPrice;
  const fe  = asset.forwardEstimates;
  if (!px || px <= 0) return 0;

  const low  = Math.min(fe.lowTarget, fe.meanTarget, fe.highTarget);
  const high = Math.max(fe.lowTarget, fe.meanTarget, fe.highTarget);
  const mode = Math.max(low, Math.min(high, fe.meanTarget));

  // Sample a price target and convert to return
  const sampledPrice = pertSample(low, mode, high);
  return (sampledPrice - px) / px;
}

// ── Dirichlet Weight Generation  ───────────────────────────────────────────────

function dirichletWeights(n) {
  const raw = Array.from({ length: n }, () => -Math.log(Math.random() + 1e-15));
  const sum = raw.reduce((s, v) => s + v, 0);
  return raw.map(v => v / sum);
}

// ── Sector Constraint Enforcement  ───────────────────────────────────────────

/** Remaining capacity for a sector before hitting its cap. */
function sectorHeadroom(indices, w, cap) {
  const sum = indices.reduce((s, i) => s + w[i], 0);
  return Math.max(0, cap - sum);
}

/**
 * Adds `amount` of weight across sectors that still have headroom below their cap.
 * Returns weight that could not be placed (no headroom left).
 */
function allocateByHeadroom(w, sectorGroups, capFor, amount, skipSectors = new Set()) {
  if (amount <= 1e-12) return 0;

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
 * Enforces sector caps while targeting a fully invested portfolio (weights sum ≈ 1).
 *
 * 1. Clip overweight sectors to their cap.
 * 2. Redistribute freed weight into other sectors with remaining headroom.
 * 3. If total weight is below 1, top up using headroom across under-cap sectors.
 *
 * If only one sector is present in the active universe, caps cannot bind and still
 * sum to 100% — weights are normalised to 1 (diversification requires multiple sectors).
 *
 * @returns {number[]} weights summing to ~1, each sector ≤ its cap
 */
export function enforceSectorConstraints(weights, assets, sectorCaps, maxIter = 40) {
  let w = [...weights];

  const sectorGroups = {};
  assets.forEach((a, i) => {
    if (!sectorGroups[a.sector]) sectorGroups[a.sector] = [];
    sectorGroups[a.sector].push(i);
  });

  const capFor = (sector) => sectorCaps[sector] ?? 1.0;
  const sumSector = (indices) => indices.reduce((s, i) => s + w[i], 0);
  const totalW = () => w.reduce((s, v) => s + v, 0);
  const nSectors = Object.keys(sectorGroups).length;

  // Single-sector universe: cap is not binding — fully invest across available names.
  if (nSectors === 1) {
    const total = totalW();
    return total > 1e-10 ? w.map(v => Math.max(0, v / total)) : w;
  }

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    for (const [sector, indices] of Object.entries(sectorGroups)) {
      const cap = capFor(sector);
      const sectorSum = sumSector(indices);

      if (sectorSum > cap + 1e-8) {
        changed = true;
        const excess = sectorSum - cap;
        indices.forEach(i => { w[i] *= cap / sectorSum; });
        allocateByHeadroom(w, sectorGroups, capFor, excess, new Set([sector]));
      }
    }

    let total = totalW();
    if (total > 1 + 1e-8) {
      changed = true;
      w = w.map(v => v / total);
    } else {
      const deficit = 1 - total;
      if (deficit > 1e-8) {
        const leftover = allocateByHeadroom(w, sectorGroups, capFor, deficit);
        if (leftover < deficit - 1e-8) changed = true;
      }
    }

    if (!changed) break;
  }

  // Final clip + top-up passes
  for (let pass = 0; pass < 8; pass++) {
    let clipped = false;
    for (const [sector, indices] of Object.entries(sectorGroups)) {
      const cap = capFor(sector);
      const sectorSum = sumSector(indices);
      if (sectorSum > cap + 1e-8) {
        clipped = true;
        const excess = sectorSum - cap;
        indices.forEach(i => { w[i] *= cap / sectorSum; });
        allocateByHeadroom(w, sectorGroups, capFor, excess, new Set([sector]));
      }
    }

    const total = totalW();
    if (total > 1 + 1e-8) {
      w = w.map(v => v / total);
    } else {
      const deficit = 1 - total;
      if (deficit > 1e-8) {
        allocateByHeadroom(w, sectorGroups, capFor, deficit);
      }
    }
    if (!clipped && Math.abs(totalW() - 1) < 1e-6) break;
  }

  const total = totalW();
  if (total > 1 + 1e-8) {
    return w.map(v => Math.max(0, v / total));
  }
  return w.map(v => Math.max(0, v));
}

// ── Monte Carlo Simulation  ───────────────────────────────────────────────────

/**
 * Runs the full Markowitz-MPT Monte Carlo simulation.
 */
export function runMonteCarloSimulation({
  assets,
  covMatrix,
  sectorCaps    = {},
  riskFreeRate  = 0.0525,
  iterations    = 5500,
}) {
  const n = assets.length;
  if (n < 2) return { portfolios: [], maxSharpePortfolio: null, minVariancePortfolio: null };

  const hasSectorCaps = Object.keys(sectorCaps).length > 0;
  const portfolios    = [];
  let maxSharpe       = -Infinity;
  let minVar          = Infinity;
  let maxSharpeIdx    = 0;
  let minVarIdx       = 0;

  for (let sim = 0; sim < iterations; sim++) {
    // ── Step 1: Sample analyst return draws for this path ─────────────────
    const pertMeans = assets.map(sampleAnalystReturn);

    // ── Step 2: Random weights ────────────────────────────────────────────
    let weights = dirichletWeights(n);

    // ── Step 3: Enforce sector constraints (if any) ───────────────────────
    if (hasSectorCaps) {
      weights = enforceSectorConstraints(weights, assets, sectorCaps);
    }

    // ── Step 4: Portfolio metrics ─────────────────────────────────────────
    const ret      = portfolioReturn(weights, pertMeans);
    const variance = portfolioVariance(weights, covMatrix);
    const risk     = Math.sqrt(variance);
    const sharpe   = sharpeRatio(ret, risk, riskFreeRate);

    const point = {
      weights,
      portfolioReturn: ret,
      portfolioRisk:   risk,
      portfolioSharpe: sharpe,
      pertMeans,
    };

    portfolios.push(point);

    if (sharpe > maxSharpe) { maxSharpe = sharpe; maxSharpeIdx = sim; }
    if (variance < minVar)  { minVar    = variance; minVarIdx  = sim; }
  }

  return {
    portfolios,
    maxSharpePortfolio:   portfolios[maxSharpeIdx],
    minVariancePortfolio: portfolios[minVarIdx],
  };
}
