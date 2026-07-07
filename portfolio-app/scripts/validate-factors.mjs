/**
 * Sanity checks for factor model, tail-aware robust mode, shrinkage, and
 * consensus/stress outputs.  Run: node scripts/validate-factors.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { computeCorrelationFromDateRange, computeCovarianceMatrix } from '../src/math/matrixEngine.js';
import { runMonteCarloSimulation, pertSample } from '../src/math/monteCarlo.js';
import { DEFAULT_FACTOR_CONFIG } from '../src/math/factorConfig.js';
import { computeFactorPreview } from '../src/math/qualityFactors.js';
import {
  computeEquilibriumReturns,
  buildBlackLittermanContext,
  computePosteriorReturns,
} from '../src/math/blackLitterman.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(__dirname, '../data/live-market-snapshot.json'), 'utf8'));
const assets = snap.assets.slice(0, 12); // Use 12 assets for a faster CI run
const { matrix, obs } = computeCorrelationFromDateRange(assets, '2023-01-01', '2024-12-31');
const { covMatrix } = computeCovarianceMatrix(matrix, assets, { shrinkage: true, nObs: obs });

const ITERS = 500; // small for speed; bump to 5000 for thorough check

// ── 1. Legacy mode (avgMuSharpe, no shrinkage) ────────────────────────────
const legacy = runMonteCarloSimulation({
  assets,
  covMatrix,
  riskFreeRate: snap.riskFreeRate,
  iterations: ITERS,
  factorConfig: { ...DEFAULT_FACTOR_CONFIG, useFactorModel: false },
  robustMode: 'avgMuSharpe',
});

// ── 2. Tail-aware default ─────────────────────────────────────────────────
const tailAware = runMonteCarloSimulation({
  assets,
  covMatrix,
  riskFreeRate: snap.riskFreeRate,
  iterations: ITERS,
  factorConfig: { ...DEFAULT_FACTOR_CONFIG, useFactorModel: false },
  robustMode: 'tailAware',
  tailPenalty: 0.10,
});

// ── 3. Factor model on ────────────────────────────────────────────────────
const factorOn = runMonteCarloSimulation({
  assets,
  covMatrix,
  riskFreeRate: snap.riskFreeRate,
  iterations: ITERS,
  factorConfig: { ...DEFAULT_FACTOR_CONFIG, useFactorModel: true },
});

// ── 4. Factor model off (all layers disabled) — regression baseline ───────
const factorOff = runMonteCarloSimulation({
  assets,
  covMatrix,
  riskFreeRate: snap.riskFreeRate,
  iterations: ITERS,
  factorConfig: { ...DEFAULT_FACTOR_CONFIG, useFactorModel: true, useBlackLitterman: false, useLiquidityRisk: false },
  robustMode: 'avgMuSharpe',
});

const preview = computeFactorPreview(assets, covMatrix, {
  ...DEFAULT_FACTOR_CONFIG,
  useFactorModel: true,
}, 1, snap.riskFreeRate);

let pass = 0, fail = 0;
function check(label, ok, note = '') {
  if (ok) { console.log('  OK:', label); pass++; }
  else     { console.warn('FAIL:', label, note); fail++; }
}

// ── Basic weight sums ─────────────────────────────────────────────────────
console.log('\n─── Weight sum checks ───────────────────────────────────────');
check('legacy robust weights sum ≈ 1',
  Math.abs(legacy.robustPortfolio.weights.reduce((s, w) => s + w, 0) - 1) < 0.01);
check('tail-aware robust weights sum ≈ 1',
  Math.abs(tailAware.robustPortfolio.weights.reduce((s, w) => s + w, 0) - 1) < 0.01);
check('factor-on robust weights sum ≈ 1',
  Math.abs(factorOn.robustPortfolio.weights.reduce((s, w) => s + w, 0) - 1) < 0.01);

// ── Consensus portfolio ───────────────────────────────────────────────────
console.log('\n─── Consensus portfolio ─────────────────────────────────────');
check('consensus portfolio exists', tailAware.consensusPortfolio != null);
if (tailAware.consensusPortfolio) {
  const cSum = tailAware.consensusPortfolio.weights.reduce((s, w) => s + w, 0);
  check('consensus weights sum ≈ 1', Math.abs(cSum - 1) < 0.01);
  check('consensus Sharpe is finite', Number.isFinite(tailAware.consensusPortfolio.portfolioSharpe));
}

// ── Tail metrics ──────────────────────────────────────────────────────────
console.log('\n─── Tail metrics ────────────────────────────────────────────');
const ts = tailAware.robustPortfolio.scenarioStats;
check('cvar5 is finite', Number.isFinite(ts?.cvar5));
check('tailGap is finite', Number.isFinite(ts?.tailGap));
check('tailGap >= 0', (ts?.tailGap ?? -1) >= 0);
check('probBelowRf in [0,1]', ts?.probBelowRf >= 0 && ts?.probBelowRf <= 1);

// ── Stress results ────────────────────────────────────────────────────────
console.log('\n─── Stress tests ────────────────────────────────────────────');
const stress = tailAware.stressResults;
check('stress results exist (≥3)', (stress?.length ?? 0) >= 3);
const allMean = stress?.find(s => s.name === 'All Mean');
const allLow  = stress?.find(s => s.name === 'All Low (Bear)');
check('All Low return < All Mean return', allLow && allMean && allLow.portfolioReturn < allMean.portfolioReturn);
check('All Mean vsMean ≈ 0', allMean && Math.abs(allMean.vsMean) < 1e-10);
check('robust Sharpe matches (μ−rf)/σ',
  Math.abs(tailAware.robustPortfolio.portfolioSharpe -
    (tailAware.robustPortfolio.portfolioReturn - snap.riskFreeRate) / tailAware.robustPortfolio.portfolioRisk) < 1e-6);

// ── Robustness frontier ───────────────────────────────────────────────────
console.log('\n─── Robustness frontier ─────────────────────────────────────');
const fp = tailAware.frontierPoints;
check('frontier has 7 points', fp?.length === 7);
if (fp?.length) {
  check('frontier point at λ=0 exists', fp.some(p => p.lambda === 0));
  check('frontier point at λ=0.10 exists', fp.some(p => p.lambda === 0.10));
  check('frontier point at λ=1 exists', fp.some(p => p.lambda === 1));
  check('all frontier weights sum ≈ 1', fp.every(p => Math.abs(p.weights.reduce((s, w) => s + w, 0) - 1) < 0.01));
}

// ── Regression: all factor layers off should produce same distribution
//    as legacy avgMuSharpe (L1 diff tolerance higher now due to subsample)
console.log('\n─── Regression ──────────────────────────────────────────────');
const wDiff = legacy.robustPortfolio.weights.reduce(
  (s, w, i) => s + Math.abs(w - factorOff.robustPortfolio.weights[i]), 0,
);
console.log('  L1 weight diff (factor layers all off vs legacy):', wDiff.toFixed(4));
check('L1 diff < 0.20 (subsample PRNG variance)', wDiff < 0.20,
  `got ${wDiff.toFixed(4)} — larger values are expected with PRNG variance at 500 iters`);

// ── BL factor checks ──────────────────────────────────────────────────────
const bird = preview.rows.find(r => r.ticker === 'BIRD');
const bbca = preview.rows.find(r => r.ticker === 'BBCA');
console.log('\n─── Black-Litterman preview ─────────────────────────────────');
if (bird && bbca) {
  console.log('  BIRD Ω:', bird.omega?.toExponential(3), 'prior', (bird.priorWt * 100).toFixed(1) + '%');
  console.log('  BBCA Ω:', bbca.omega?.toExponential(3), 'prior', (bbca.priorWt * 100).toFixed(1) + '%');
  check('BIRD Ω > BBCA Ω (lower coverage = more uncertainty)', bird.omega > bbca.omega);
  check('BBCA prior > BIRD prior (large-cap)', bbca.priorWt > bird.priorWt);
}

// ── PERT sampler moments ──────────────────────────────────────────────────
// Standard Beta-PERT: E[X] = (low + 4·mode + high)/6. Deriving the α shapes
// from the mean instead of the mode biases E[X] toward the range midpoint
// by (low + high − 2·mode)/9 — this check catches that regression.
console.log('\n─── PERT sampler ────────────────────────────────────────────');
{
  const low = 100, mode = 110, high = 200;
  const N = 200000;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += pertSample(low, mode, high);
  const empirical = sum / N;
  const expected = (low + 4 * mode + high) / 6; // 123.33; mean-parameterized bug gives ~132.2
  console.log(`  empirical mean ${empirical.toFixed(2)} vs PERT mean ${expected.toFixed(2)}`);
  check('PERT empirical mean matches (low+4·mode+high)/6', Math.abs(empirical - expected) < 0.5,
    `got ${empirical.toFixed(2)}, expected ${expected.toFixed(2)}`);
}

// ── Black-Litterman unit conventions ──────────────────────────────────────
// π must be a TOTAL return (r_f + δΣw) so it blends coherently with the
// total-return views Q and downstream Sharpe (which subtracts r_f itself).
console.log('\n─── Black-Litterman units ───────────────────────────────────');
{
  const rf = snap.riskFreeRate;
  const capsRaw = assets.map(a => a.meta?.marketCap ?? 0);
  const capSum = capsRaw.reduce((s, v) => s + v, 0);
  const capW = capsRaw.map(v => v / capSum);

  // By construction δ = 0.08 / w'Σw, so w'π_total = r_f + 0.08 exactly.
  const piTotal = computeEquilibriumReturns(covMatrix, capW, { riskFreeRate: rf });
  const capRet = piTotal.reduce((s, p, i) => s + p * capW[i], 0);
  check('cap-weighted π equals r_f + 8% equity premium (total-return space)',
    Math.abs(capRet - (rf + 0.08)) < 1e-9, `got ${(capRet * 100).toFixed(3)}%`);

  const Q = assets.map(a => {
    const px = a.meta.currentPrice, fe = a.forwardEstimates;
    if (!px || px <= 0) return 0;
    return (fe.meanTarget - px) / px + (a.meta?.dividendYield ?? 0);
  });
  const maxAnalysts = Math.max(...assets.map(a => a.forwardEstimates?.totalAnalysts ?? 1));
  const mkCtx = (omegaScale) => buildBlackLittermanContext({
    assets, covMatrix, capWeights: capW,
    factorConfig: { ...DEFAULT_FACTOR_CONFIG, useFactorModel: true, omegaScale },
    maxAnalysts, riskFreeRate: rf,
  });

  // Ω → ∞ (views worthless): posterior collapses to the prior π.
  const muPrior = computePosteriorReturns(Q, covMatrix, mkCtx(1e9));
  const maxDevPrior = Math.max(...muPrior.map((m, i) => Math.abs(m - piTotal[i])));
  check('Ω→∞ posterior ≈ π (total prior)', maxDevPrior < 1e-4,
    `max |μ_BL − π| = ${maxDevPrior.toExponential(2)}`);

  // Ω → 0 (views exact): posterior collapses to Q.
  const muViews = computePosteriorReturns(Q, covMatrix, mkCtx(1e-12));
  const maxDevQ = Math.max(...muViews.map((m, i) => Math.abs(m - Q[i])));
  check('Ω→0 posterior ≈ Q', maxDevQ < 1e-4,
    `max |μ_BL − Q| = ${maxDevQ.toExponential(2)}`);

  // τ fallback matches the documented IDX default.
  const ctxDefault = buildBlackLittermanContext({
    assets, covMatrix, capWeights: capW, factorConfig: {}, maxAnalysts, riskFreeRate: rf,
  });
  check('τ fallback is 0.03 (DEFAULT_FACTOR_CONFIG)', ctxDefault.tau === 0.03,
    `got ${ctxDefault.tau}`);
}

console.log(`\n═══ Result: ${pass} passed, ${fail} failed ═══`);
if (fail > 0) process.exit(1);
