/**
 * grid-report.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * FULL CROSS-TAB of the μ-source × τ × frequency × κ × objective grid, reporting
 * net vs gross Sharpe, annual return, vol, turnover, cost drag and max drawdown.
 *
 * Where sweep-configs.mjs RECOMMENDS (ranks, picks a family, prints settings), this
 * EXPLAINS — it dumps every cell so the trade-offs are visible rather than collapsed
 * into one winner. Same engine, same look-ahead-free walk; different output shape.
 *
 *   npm run grid                          # default grid
 *   UNIVERSE=BBCA,BBRI,… npm run grid     # for a specific selection
 *
 * ── Why κ is driven from OUT HERE ────────────────────────────────────────────
 * runStrategyBacktest's built-in `kappaSweep` only sweeps κ for the ONE reference
 * tail-λ, so it cannot answer "how does κ interact with each objective". Setting the
 * fixed `kappa` per run instead gives every variant at every κ, at the cost of one
 * engine call per κ. Σ is shared across all of them via riskCache, so the extra cost
 * is optimizer walks only.
 *
 * ── Ω defaults to the NEUTRAL setting ────────────────────────────────────────
 * analystConfidence and dispersionOmega default to 0 here, unlike the live optimizer.
 * They read analyst COUNT and target SPREAD, which the dated target archive does not
 * carry — those come from the weekly captures, which only begin in 2026, so switching
 * them on applies present-day values at historical steps. Measured, that flatters the
 * full window and costs the held-out slice. Override with ANALYST_CONF / DISP_OMEGA.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runStrategyBacktest, DEFAULT_WINDOW_START } from '../src/backtestEngine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const num = (env, d) => (process.env[env] ? Number(process.env[env]) : d);

const data = JSON.parse(readFileSync(join(publicDir, 'backtest-history.json'), 'utf8'));
const viewsPath = process.env.VIEWS_FILE
  || join(__dirname, '..', '..', 'portfolio-app', 'data', 'analyst-views.json');
const views = existsSync(viewsPath) ? JSON.parse(readFileSync(viewsPath, 'utf8')) : null;
if (!views) { console.error(`❌  Needs ${viewsPath} — run: node portfolio-app/scripts/import-analyst-views.mjs`); process.exit(1); }

const windowStartEnv = process.env.WINDOW_START;
const windowStart = windowStartEnv === 'none' ? null : (windowStartEnv || DEFAULT_WINDOW_START);
const LISTING_CUTOFF = process.env.LISTING_CUTOFF
  || (windowStart ? new Date(Date.parse(`${windowStart}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10) : '2012-01-01');

const known = new Map(data.tickers.map(t => [t.ticker, t]));
let universe, selectionLabel;
if (process.env.UNIVERSE) {
  const req = process.env.UNIVERSE.split(',').map(s => s.trim().replace(/\.JK$/i, '')).filter(Boolean);
  const unknown = req.filter(t => !known.has(t));
  if (unknown.length) { console.error(`❌  Not in backtest-history.json: ${unknown.join(', ')}`); process.exit(1); }
  universe = [...new Set(req)];
  selectionLabel = `explicit selection (${universe.length} names)`;
} else {
  universe = data.tickers.filter(t => t.listing && t.listing <= LISTING_CUTOFF).map(t => t.ticker);
  selectionLabel = `${universe.length} long-history names (listed ≤ ${LISTING_CUTOFF})`;
}

// ── the grid ──────────────────────────────────────────────────────────────────
// Two PURE rows (no equilibrium anchor — μ is the signal outright) against BL at a
// τ ladder, so "does the anchor help, and how hard should it pull" is one table.
const TAUS = (process.env.TAUS || '0.01,0.03,0.10,0.30').split(',').map(Number);
const CONFIGS = [
  { id: 'pure · 1yr past return', priorMode: 'none', viewMode: 'off', tau: null },
  { id: 'pure · 12M targets', priorMode: 'none', viewMode: 'analyst', tau: null },
  { id: 'BL · no signal', priorMode: 'cap', viewMode: 'off', tau: null },
  ...TAUS.map(t => ({ id: `BL · 12M targets τ=${t}`, priorMode: 'cap', viewMode: 'analyst', tau: t })),
];
// κ binds on BOTH objectives. It did not always: buildRobustObjective's 'avgMuSharpe'
// branch used to return early with the Sharpe term alone, so κ was silently inert for
// Max-Sharpe — the variant that wins most of these grids — while still being accepted and
// echoed back in params. Fixed in robustObjective.js (κ = 0 is byte-identical to the old
// behavior). Min-Var reaches κ by a third route, minVarTurnoverPenalized.
// If a Max-Sharpe row is ever identical across two κ values again, suspect that regression
// first: at the optimizer's default step size, κ has to clear roughly 0.1 before it moves
// the argmax at all, so small-κ flatness is expected but large-κ flatness is not.
const KAPPAS = (process.env.KAPPAS || '0,0.1,0.25,0.5').split(',').map(Number);
const FREQS = (process.env.FREQS || 'weekly,monthly,quarterly').split(',');
const paths = num('PATHS', 12);
const optimizeMaxIter = num('MAXITER', 20);
const factorBase = {
  omegaScale: num('OMEGA_SCALE', 0.05),
  analystConfidence: num('ANALYST_CONF', 0),   // neutral by default — see header
  dispersionOmega: num('DISP_OMEGA', 0),
};

console.log(`\n📐  Grid report — ${selectionLabel}`);
console.log(`    ${universe.join(', ')}\n`);
console.log(`    ${CONFIGS.length} μ-configs × ${KAPPAS.length} κ × ${FREQS.length} freq × 4 objectives`);
console.log(`    paths=${paths} · Ω: analystConf=${factorBase.analystConfidence} dispOmega=${factorBase.dispersionOmega} (neutral)\n`);

const riskCache = new Map();   // Σ built once per frequency, shared across the whole grid
const cells = [];
const t0 = Date.now();
let n = 0;
const total = CONFIGS.length * KAPPAS.length;

for (const c of CONFIGS) {
  for (const kappa of KAPPAS) {
    const res = runStrategyBacktest(data, universe, {
      frequencies: FREQS, paths, optimizeMaxIter, seed: 12345,
      kappa, kappaSweep: [kappa],            // internal sweep off — κ is driven from here
      tailPenalty: 0.5,
      priorMode: c.priorMode, viewMode: c.viewMode, views,
      factorConfig: { ...factorBase, ...(c.tau != null ? { tau: c.tau } : {}) },
      windowStart, riskCache,
    });
    n++;
    if (!res.ok) { console.log(`  [${n}/${total}] ${c.id} κ=${kappa} ✗`); continue; }
    for (const [freq, fb] of Object.entries(res.byFrequency)) {
      for (const v of res.params.variants) {
        const m = fb.metrics[v.key]; if (!m) continue;
        cells.push({
          config: c.id, priorMode: c.priorMode, viewMode: c.viewMode, tau: c.tau,
          kappa, freq, objective: v.label, lambda: v.tailPenalty,
          net: m.sharpe, gross: m.grossSharpe,
          annReturn: m.annReturn, grossAnnReturn: m.grossAnnReturn, annVol: m.annVol,
          turnover: m.annualTurnover, drag: m.annualCostDrag, maxDD: m.maxDrawdown, tStat: m.tStat,
        });
      }
      // Baselines are μ-independent; capture once per (freq) from the first pass.
      for (const k of ['MinVar', 'EqualWeight', 'IHSG']) {
        const m = fb.metrics[k]; if (!m) continue;
        if (cells.some(x => x.config === `baseline · ${k}` && x.freq === freq && x.kappa === kappa)) continue;
        cells.push({ config: `baseline · ${k}`, priorMode: '—', viewMode: '—', tau: null,
          kappa, freq, objective: k, lambda: null,
          net: m.sharpe, gross: m.grossSharpe, annReturn: m.annReturn,
          grossAnnReturn: m.grossAnnReturn ?? m.annReturn, annVol: m.annVol,
          turnover: m.annualTurnover ?? 0, drag: m.annualCostDrag ?? 0,
          maxDD: m.maxDrawdown, tStat: m.tStat ?? 0, isBaseline: true });
      }
    }
    console.log(`  [${String(n).padStart(2)}/${total}] ${c.id.padEnd(26)} κ=${String(kappa).padEnd(5)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}

// ── report ────────────────────────────────────────────────────────────────────
const pct = v => `${(v * 100).toFixed(1)}%`;
const f2 = v => v.toFixed(2).padStart(6);

for (const freq of FREQS) {
  console.log(`\n\n${'═'.repeat(120)}`);
  console.log(`${freq.toUpperCase()}`);
  console.log('═'.repeat(120));
  console.log(`${'configuration'.padEnd(26)}${'objective'.padEnd(13)}${'κ'.padStart(5)}${'S net'.padStart(7)}${'S gross'.padStart(8)}${'ret net'.padStart(9)}${'ret grs'.padStart(9)}${'vol'.padStart(7)}${'turn'.padStart(8)}${'drag'.padStart(7)}${'maxDD'.padStart(7)}`);
  console.log('─'.repeat(120));
  const rows = cells.filter(c => c.freq === freq && !c.isBaseline)
    .sort((a, b) => b.net - a.net);
  const shown = process.env.ALL ? rows : rows.filter(r => ['Max-Sharpe', 'Tail λ=0.5'].includes(r.objective));
  for (const r of shown.slice(0, num('ROWS', 28))) {
    console.log(r.config.padEnd(26) + r.objective.padEnd(13) + String(r.kappa).padStart(5) +
      f2(r.net).padStart(7) + f2(r.gross).padStart(8) + pct(r.annReturn).padStart(9) +
      pct(r.grossAnnReturn).padStart(9) + pct(r.annVol).padStart(7) +
      `${r.turnover.toFixed(1)}×`.padStart(8) + pct(r.drag).padStart(7) + pct(r.maxDD).padStart(7));
  }
  const bl = cells.filter(c => c.freq === freq && c.isBaseline);
  const seen = new Set();
  for (const b of bl) { if (seen.has(b.objective)) continue; seen.add(b.objective);
    console.log(`${('baseline · ' + b.objective).padEnd(26)}${''.padEnd(13)}${''.padStart(5)}${f2(b.net).padStart(7)}${f2(b.gross).padStart(8)}${pct(b.annReturn).padStart(9)}${pct(b.grossAnnReturn).padStart(9)}${pct(b.annVol).padStart(7)}${(b.turnover.toFixed(1) + '×').padStart(8)}${pct(b.drag).padStart(7)}${pct(b.maxDD).padStart(7)}`);
  }
}

const outPath = join(publicDir, process.env.OUTFILE || 'grid-report.json');
writeFileSync(outPath, JSON.stringify({
  generated: new Date().toISOString(), universe, selectionLabel, windowStart,
  grid: { configs: CONFIGS.map(c => c.id), taus: TAUS, kappas: KAPPAS, freqs: FREQS },
  fidelity: { paths, optimizeMaxIter, factorConfig: factorBase },
  cells,
}, null, 2));
console.log(`\n📦  ${outPath}   (${((Date.now() - t0) / 1000).toFixed(0)}s, ${cells.length} cells)\n`);
