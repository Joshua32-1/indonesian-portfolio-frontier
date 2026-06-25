/**
 * run-strategy-backtest.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Node ESM precompute (run via: npm run backtest).
 *
 * The strategy backtest optimizes the production objective per rebalance × per
 * tail-objective variant (Max-Sharpe + tail-λ levels) × per frequency, plus a κ-sweep
 * per frequency — far too heavy to recompute live on a universe toggle. So we compute
 * it ONCE here over the default universe and cache the result to
 * public/backtest-results.json (gross + net curves per variant), which the app renders.
 *
 * Reuses runStrategyBacktest from src/backtestEngine.js (the pure, look-ahead-free
 * walk-forward engine), so the offline result and any future live run share code.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runStrategyBacktest } from '../src/backtestEngine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

function main() {
  const historyPath = join(publicDir, 'backtest-history.json');
  let data;
  try {
    data = JSON.parse(readFileSync(historyPath, 'utf8'));
  } catch (e) {
    console.error(`❌  Could not read ${historyPath} — run \`npm run fetch\` first.\n   ${e.message}`);
    process.exit(1);
  }

  // Restrict to the LONG-HISTORY core: the window starts at (newest listing + 1yr),
  // so including recently-listed names (e.g. AADI 2024) would truncate the backtest to
  // a few months. Names listed on/before LISTING_CUTOFF keep a ~15-year window.
  const LISTING_CUTOFF = process.env.LISTING_CUTOFF || '2012-01-01';
  const universe = data.tickers.filter(t => t.listing && t.listing <= LISTING_CUTOFF).map(t => t.ticker);
  const excluded = data.tickers.filter(t => !(t.listing && t.listing <= LISTING_CUTOFF)).map(t => t.ticker);
  console.log(`🚀  Strategy backtest — ${universe.length} long-history names (listed ≤ ${LISTING_CUTOFF}), tail-aware machinery`);
  console.log(`    included: ${universe.join(', ')}`);
  console.log(`    excluded (too new): ${excluded.join(', ') || '(none)'}\n`);

  // Defaults sized for a tractable offline run. Each frequency runs 4 variants + a
  // κ-sweep, so the full weekly+monthly+quarterly run is heavy (~40–60 min). Override
  // via env for a faster pass, e.g.:
  //   FREQS=monthly,quarterly PATHS=70 MAXITER=25 npm run backtest
  //   LAMBDAS=0,0.5 KAPPA=0.25 npm run backtest
  const num = (env, d) => (process.env[env] ? Number(process.env[env]) : d);
  const list = (env, d) => (process.env[env] ? process.env[env].split(',').map(Number) : d);
  const frequencies = process.env.FREQS ? process.env.FREQS.split(',') : ['weekly', 'monthly', 'quarterly'];
  const lambdas = list('LAMBDAS', null); // override the tail-λ variant set if provided
  const variants = lambdas
    ? [{ key: 'MaxSharpe', label: 'Max-Sharpe', mode: 'avgMuSharpe', tailPenalty: 0 },
       ...lambdas.map(l => ({ key: `Tail${String(l).replace('.', '')}`, label: `Tail λ=${l}`, mode: 'tailAware', tailPenalty: l }))]
    : undefined; // → engine default (Max-Sharpe + λ 0.25/0.5/1.0)

  const t0 = Date.now();
  const result = runStrategyBacktest(data, universe, {
    ...(variants ? { variants } : {}),
    kappa: num('KAPPA', 0.25),
    kappaSweep: list('KAPPAS', [0, 0.05, 0.1, 0.25, 0.5]),
    frequencies,
    paths: num('PATHS', 100),
    tailPenalty: num('TAILPEN', 0.5),
    optimizeMaxIter: num('MAXITER', 35),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!result.ok) {
    console.error(`❌  Backtest did not run: ${(result.warnings || []).join('; ')}`);
    process.exit(1);
  }

  for (const w of result.warnings) console.log(`  ⚠️  ${w}`);
  console.log(`\n  cost model: ${result.params.costModel} | cap weights: ${result.params.capMode} | fixed κ=${result.params.kappa}`);
  console.log(`  window: ${result.window.start} → ${result.window.end} | variants: ${result.params.variants.map(v => v.label).join(', ')}`);
  const fmt = m => `S(net)=${m.sharpe.toFixed(2)} S(gr)=${m.grossSharpe.toFixed(2)} IR=${(m.infoRatio ?? 0).toFixed(2)} t=${(m.tStat ?? 0).toFixed(1)} MDD=${(m.maxDrawdown * 100).toFixed(0)}% turn=${m.annualTurnover.toFixed(1)}× drag=${(m.annualCostDrag * 100).toFixed(2)}%`;
  for (const [fk, fb] of Object.entries(result.byFrequency)) {
    console.log(`\n  ── ${fb.label} (${fb.nRebalances} rebalances) ──`);
    for (const v of result.params.variants) console.log(`    ${v.label.padEnd(12)}: ${fmt(fb.metrics[v.key])}`);
    console.log(`    ${'Min-Var'.padEnd(12)}: ${fmt(fb.metrics.MinVar)}`);
    console.log(`    ${'Equal-Wt'.padEnd(12)}: ${fmt(fb.metrics.EqualWeight)}`);
    console.log(`    ${'IHSG'.padEnd(12)}: S(net)=${fb.metrics.IHSG.sharpe.toFixed(2)}`);
  }

  const payload = { generated: new Date().toISOString(), universe, ...result };
  const outPath = join(publicDir, 'backtest-results.json');
  writeFileSync(outPath, JSON.stringify(payload));
  console.log(`\n📦  Written → ${outPath}  (${secs}s)\n`);
}

main();
