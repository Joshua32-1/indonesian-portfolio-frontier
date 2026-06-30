#!/usr/bin/env node
/**
 * optimize.mjs — headless weekly rebalance optimizer.
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs the same math as the browser Analytics tab (Monte Carlo + Black-Litterman
 * + tail-aware robust optimization) with NO React and NO DOM, then APPENDS a new
 * dated rebalance entry for each tracked strategy to the dashboard's
 * portfolios.json. Drives the automated weekly-rebalance GitHub Action.
 *
 * Variant → dashboard id mapping (matches the 6 tracked strategies):
 *   consensusPortfolio        → max-sharpe
 *   minVariancePortfolio      → min-var
 *   frontier λ=0.10/0.20/0.35/0.50 → tail-10 / tail-20 / tail-35 / tail-50
 *
 * Usage:
 *   node scripts/optimize.mjs [--effective YYYY-MM-DD] [--dry-run]
 *   REBALANCE_EFFECTIVE=2026-06-29 node scripts/optimize.mjs
 *
 * Reads:  portfolio-app/data/live-market-snapshot.json   (rich snapshot — run fetch-snapshot first)
 *         portfolio-app/optimizer-config.json            (methodology config)
 *         live-dashboard-portfolio/data/live-market-snapshot.json (lean — ticker validation)
 * Writes: live-dashboard-portfolio/data/portfolios.json  (append-only)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { computeCorrelationFromDateRange, computeCovarianceMatrix, MIN_CORR_OBS } from '../src/math/matrixEngine.js';
import { runMonteCarloSimulation } from '../src/math/monteCarlo.js';
import { DEFAULT_FACTOR_CONFIG } from '../src/math/factorConfig.js';
import { DEFAULT_SIM_CONFIG } from '../src/math/simConfig.js';
import { buildSectorCapsForSectors } from '../src/math/sectorCaps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT  = join(__dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..');

const SNAPSHOT      = join(APP_ROOT, 'data', 'live-market-snapshot.json');
const CONFIG        = join(APP_ROOT, 'optimizer-config.json');
const PORTFOLIOS    = join(REPO_ROOT, 'live-dashboard-portfolio', 'data', 'portfolios.json');
const LEAN_SNAPSHOT = join(REPO_ROOT, 'live-dashboard-portfolio', 'data', 'live-market-snapshot.json');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const iterIdx = args.indexOf('--iterations');
const iterOverride = iterIdx >= 0 ? Number(args[iterIdx + 1]) : null;
const pathsIdx = args.indexOf('--paths');
const pathsOverride = pathsIdx >= 0 ? Number(args[pathsIdx + 1]) : null;
// Methodology matrix flags (resolved against config defaults after cfg loads):
//   --methodology pert|bl   pert = legacy PERT consensus (BL off); bl = Black-Litterman
//   --prior-mode cap|shrunk|equal   BL equilibrium prior (bl only)
//   --tau <number>          BL prior-vs-views blend (bl only)
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const methodologyArg = argVal('--methodology');
const priorModeArg   = argVal('--prior-mode');
const tauArg         = argVal('--tau');
// --emit <file>: write this config's streams to an artifact instead of appending
// portfolios.json (so parallel cron jobs never clobber the shared file).
const emitArg        = argVal('--emit');
const effIdx = args.indexOf('--effective');
const effective =
  (effIdx >= 0 && args[effIdx + 1]) ? args[effIdx + 1]
  : process.env.REBALANCE_EFFECTIVE || new Date().toISOString().slice(0, 10);

if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) {
  console.error(`Invalid effective date: "${effective}" (expected YYYY-MM-DD)`);
  process.exit(1);
}

// ── Load inputs ─────────────────────────────────────────────────────────────
if (!existsSync(SNAPSHOT)) {
  console.error('Missing rich snapshot — run `npm run fetch-snapshot` in portfolio-app first.');
  process.exit(1);
}
const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const cfg  = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
const assets = snap.assets ?? [];
const riskFreeRate = snap.riskFreeRate ?? 0.0575;

if (assets.length < 2) {
  console.error('Snapshot has fewer than 2 assets — nothing to optimize.');
  process.exit(1);
}

// Merge config onto module defaults (config wins)
const factorConfig   = { ...DEFAULT_FACTOR_CONFIG, ...(cfg.factorConfig ?? {}) };

// ── Resolve methodology matrix (CLI > config default) ───────────────────────────
const methodology = methodologyArg ?? (factorConfig.useFactorModel ? 'bl' : 'pert');
if (!['pert', 'bl'].includes(methodology)) {
  console.error(`Invalid --methodology: "${methodology}" (expected pert|bl)`); process.exit(1);
}
const priorMode = priorModeArg ?? 'cap';
if (!['cap', 'shrunk', 'equal'].includes(priorMode)) {
  console.error(`Invalid --prior-mode: "${priorMode}" (expected cap|shrunk|equal)`); process.exit(1);
}
const tau = tauArg != null ? Number(tauArg) : (factorConfig.tau ?? 0.03);
if (!(tau > 0)) { console.error(`Invalid --tau: "${tauArg}" (expected positive number)`); process.exit(1); }
// Apply to the factor config: BL on/off + τ. (PERT ⇒ BL inactive ⇒ prior/τ are no-ops.)
factorConfig.useFactorModel = methodology === 'bl';
if (methodology === 'bl') factorConfig.tau = tau;
// Config tag for composite ids: `pert` or `bl-<prior>-t<NN>` (NN = round(τ·100), e.g. t03).
const tauTag = String(Math.round(tau * 100)).padStart(2, '0');
const configTag = methodology === 'pert' ? 'pert' : `bl-${priorMode}-t${tauTag}`;
const simConfig      = { ...DEFAULT_SIM_CONFIG, ...(cfg.simConfig ?? {}) };
if (pathsOverride) simConfig.optimizerPaths = pathsOverride;
const iterations     = iterOverride ?? cfg.mcIterations ?? 100000;
const maxPositionCap = cfg.maxPositionCap ?? 1.0;
const volHalfLife    = cfg.volHalfLife ?? 63;
const corrStart      = cfg.corrStart ?? '1900-01-01';
const corrEnd        = cfg.corrEnd ?? '2100-01-01';
const sectors        = [...new Set(assets.map(a => a.sector))];
const sectorCaps     = cfg.sectorCaps ?? buildSectorCapsForSectors(sectors);

console.log('─── Optimizer config ───────────────────────────────────────');
console.log(`  effective:      ${effective}`);
console.log(`  assets:         ${assets.length}  ·  rf=${(riskFreeRate * 100).toFixed(2)}%`);
console.log(`  iterations:     ${iterations.toLocaleString('en-US')}`);
console.log(`  corr window:    ${corrStart} → ${corrEnd}  ·  volHalfLife=${volHalfLife}`);
console.log(`  factor model:   ${factorConfig.useFactorModel ? 'ON (BL τ=' + factorConfig.tau + ')' : 'OFF (legacy PERT)'}`);
console.log(`  methodology:    ${methodology}  ·  prior=${methodology === 'bl' ? priorMode : '—'}  ·  tag=${configTag}`);
console.log(`  robust:         ${simConfig.robustMode}  ·  λ=${simConfig.tailPenalty}  ·  paths=${simConfig.optimizerPaths}`);

// ── Correlation + covariance ────────────────────────────────────────────────
const { matrix, obs } = computeCorrelationFromDateRange(assets, corrStart, corrEnd);
if (obs < MIN_CORR_OBS) {
  console.error(`Only ${obs} weekly correlation observations (< ${MIN_CORR_OBS}). Widen corr window or refresh snapshot.`);
  process.exit(1);
}
const { covMatrix } = computeCovarianceMatrix(matrix, assets, {
  volHalfLife,
  shrinkage: simConfig.shrinkage,
  nObs: obs,
});

// ── Run the simulation ──────────────────────────────────────────────────────
console.log('\n─── Running Monte Carlo ─────────────────────────────────────');
const t0 = Date.now();
const result = runMonteCarloSimulation({
  assets,
  covMatrix,
  sectorCaps,
  maxPositionCap,
  riskFreeRate,
  iterations,
  factorConfig,
  robustMode:          simConfig.robustMode,
  tailPenalty:         simConfig.tailPenalty,
  deterministicStarts: simConfig.deterministicStarts,
  optimizerPaths:      simConfig.optimizerPaths,
  priorMode,
});
console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── Map optimizer variants → dashboard ids ──────────────────────────────────
const tickers = assets.map(a => a.ticker);

function frontierWeights(lambda) {
  const fp = result.frontierPoints?.find(p => Math.abs(p.lambda - lambda) < 1e-8);
  if (!fp) throw new Error(`No frontier point for λ=${lambda}`);
  return fp.weights;
}

/** Round to 4 dp, then fold the residual into the largest weight so the map sums to exactly 1. */
function toWeightMap(weightArray) {
  const rounded = weightArray.map(w => Math.round(Math.max(0, w) * 10000) / 10000);
  const sum = rounded.reduce((s, w) => s + w, 0);
  const residual = +(1 - sum).toFixed(4);
  if (residual !== 0) {
    let maxIdx = 0;
    for (let i = 1; i < rounded.length; i++) if (rounded[i] > rounded[maxIdx]) maxIdx = i;
    rounded[maxIdx] = +(rounded[maxIdx] + residual).toFixed(4);
  }
  const out = {};
  tickers.forEach((t, i) => { out[t] = rounded[i]; });
  return out;
}

// Composite ids tag each variant with its methodology config so the 6 variants land
// on the matching `<base>@<configTag>` entries in portfolios.json (the matrix streams).
const variantWeights = {
  [`max-sharpe@${configTag}`]: result.consensusPortfolio?.weights,
  [`min-var@${configTag}`]:    result.minVariancePortfolio?.weights,
  [`tail-10@${configTag}`]:    frontierWeights(0.10),
  [`tail-20@${configTag}`]:    frontierWeights(0.20),
  [`tail-35@${configTag}`]:    frontierWeights(0.35),
  [`tail-50@${configTag}`]:    frontierWeights(0.50),
};

// ── Lean-snapshot ticker set (shared by emit + append validation) ────────────
const leanTickers = existsSync(LEAN_SNAPSHOT)
  ? new Set((JSON.parse(readFileSync(LEAN_SNAPSHOT, 'utf8')).assets ?? []).map(a => a.ticker))
  : null;

/** Validate one variant's raw weights → weight map (sum≈1, tickers in dashboard snapshot). */
function validatedWeightMap(id, raw) {
  if (!raw) throw new Error(`${id} — no optimizer weights`);
  const weights = toWeightMap(raw);
  const sum = Object.values(weights).reduce((s, x) => s + x, 0);
  if (Math.abs(sum - 1) > 0.005) throw new Error(`${id} — weights sum ${sum.toFixed(4)} (must be ≈ 1.00)`);
  if (leanTickers) {
    const missing = Object.keys(weights).filter(t => !leanTickers.has(t));
    if (missing.length) throw new Error(`${id} — tickers not in dashboard snapshot: ${missing.join(', ')}`);
  }
  return weights;
}

// ── --emit mode: write this config's 6 streams to an artifact (parallel cron) ─
if (emitArg) {
  const streams = {};
  let problems = 0;
  for (const [id, raw] of Object.entries(variantWeights)) {
    try { streams[id] = validatedWeightMap(id, raw); }
    catch (e) { console.error(`  FAIL  ${e.message}`); problems++; }
  }
  if (problems > 0) { console.error(`\n${problems} stream(s) failed validation — not emitting.`); process.exit(1); }
  if (dryRun) { console.log(`\n[dry-run] would emit ${Object.keys(streams).length} streams → ${emitArg}`); process.exit(0); }
  writeFileSync(emitArg, JSON.stringify({ effective, configTag, streams }, null, 2) + '\n');
  console.log(`\nEmitted ${Object.keys(streams).length} streams (${configTag}, ${effective}) → ${emitArg}`);
  process.exit(0);
}

// ── Append to dashboard portfolios.json (append-only) ───────────────────────
const portfolios  = JSON.parse(readFileSync(PORTFOLIOS, 'utf8'));

console.log('\n─── Appending rebalances ────────────────────────────────────');
let changed = 0;
let problems = 0;
for (const p of portfolios.portfolios) {
  const raw = variantWeights[p.id];
  if (!raw) { console.warn(`  SKIP  ${p.id} — no optimizer variant mapped`); continue; }

  const last = p.rebalances.at(-1);
  if (last && last.effective === effective) {
    console.warn(`  SKIP  ${p.id} — rebalance for ${effective} already exists`);
    continue;
  }

  const weights = toWeightMap(raw);
  const sum = Object.values(weights).reduce((s, x) => s + x, 0);
  if (Math.abs(sum - 1) > 0.005) {
    console.error(`  FAIL  ${p.id} — weights sum ${sum.toFixed(4)} (must be ≈ 1.00)`);
    problems++;
    continue;
  }
  if (leanTickers) {
    const missing = Object.keys(weights).filter(t => !leanTickers.has(t));
    if (missing.length) {
      console.error(`  FAIL  ${p.id} — tickers not in dashboard snapshot: ${missing.join(', ')}`);
      problems++;
      continue;
    }
  }

  p.rebalances.push({ effective, weights });
  changed++;
  console.log(`  OK    ${p.id.padEnd(12)} ${effective}  sum=${sum.toFixed(4)}`);
}

if (problems > 0) {
  console.error(`\n${problems} strategy(ies) failed validation — aborting without writing.`);
  process.exit(1);
}

portfolios.updated = effective;

if (dryRun) {
  console.log('\n[dry-run] no files written.');
} else if (changed === 0) {
  console.log('\nNo new rebalances to write (all up to date for this effective date).');
} else {
  writeFileSync(PORTFOLIOS, JSON.stringify(portfolios, null, 2) + '\n');
  console.log(`\nWrote ${changed} rebalance entr${changed === 1 ? 'y' : 'ies'} to portfolios.json (updated=${effective}).`);
}
