/**
 * sweep-configs.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Config search for a GIVEN STOCK SELECTION.
 *
 * Change the universe, run this, and it tells you which optimizer configuration the
 * history actually supports for those names — then prints the exact settings to carry
 * back into portfolio-app (optimizer-config.json / optimize.mjs flags).
 *
 *   UNIVERSE=BBCA,BBRI,TLKM,… npm run sweep     # the selection you care about
 *   npm run sweep                               # the listing-cutoff default
 *
 * ── What is searched ─────────────────────────────────────────────────────────
 * Only the μ-SOURCE axes are iterated, because λ (tail penalty), κ (turnover penalty)
 * and rebalance frequency are ALREADY swept inside a single runStrategyBacktest call —
 * they come free. So the grid is:
 *
 *   PRIOR ∈ {cap, shrunk, equal, none}   ANCHOR
 *   VIEWS ∈ {off, hybrid, analyst}       SIGNAL
 *   TAU   ∈ {0.01, 0.03, 0.10}           π-vs-Q blend (only when BOTH a prior and views exist)
 *
 * Σ is built ONCE per frequency and shared across every config (riskCache) — it is ~34 ms
 * per step against ~4-5 ms for an optimizer walk, so this roughly halves the sweep.
 *
 * ── Why the ranking is out-of-sample ─────────────────────────────────────────
 * This is the whole methodological point. Every strategy in this backtest has a t-stat
 * around 0.1-0.3, so the argmax over a config grid is mostly noise: pick the best
 * in-sample cell out of ~50 and you have selected a lucky draw, not a setting.
 *
 * So the walk is split by DATE: configs are ranked on the TRAIN slice only, and the
 * winner's TEST-slice result is reported beside it as the honest estimate. A large
 * train→test drop is the signal that the grid was mined rather than searched. The split
 * is post-hoc on the realized return series of one continuous walk-forward, so no
 * look-ahead is introduced — the test slice is simply the later part of the same run.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runStrategyBacktest, pitUniverse, DEFAULT_WINDOW_START } from '../src/backtestEngine.js';
import { sharpeFromExcess } from '../../portfolio-app/src/math/performance.js';
import { perPeriodRate } from '../../portfolio-app/data/bi-rate.js';
import { tierAtMost, toBare } from '../../portfolio-app/data/universe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const num = (env, d) => (process.env[env] ? Number(process.env[env]) : d);

// ── inputs ────────────────────────────────────────────────────────────────────
// HISTORY_FILE lets a WIDE research fetch live in its own file, so the 25-name default that
// `npm run dev` keeps current is never clobbered:
//   TIER=broad npm run fetch -- --out public/backtest-history-extended.json
const historyPath = process.env.HISTORY_FILE
  ? (process.env.HISTORY_FILE.startsWith('/') ? process.env.HISTORY_FILE : join(publicDir, process.env.HISTORY_FILE))
  : join(publicDir, 'backtest-history.json');
const data = JSON.parse(readFileSync(historyPath, 'utf8'));
const viewsPath = process.env.VIEWS_FILE
  || join(__dirname, '..', '..', 'portfolio-app', 'data', 'analyst-views.json');
const views = existsSync(viewsPath) ? JSON.parse(readFileSync(viewsPath, 'utf8')) : null;
if (!views) console.warn(`⚠️   No analyst archive at ${viewsPath} — view configs will be skipped.`);

const windowStartEnv = process.env.WINDOW_START;
const windowStart = windowStartEnv === 'none' ? null : (windowStartEnv || DEFAULT_WINDOW_START);
const LISTING_CUTOFF = process.env.LISTING_CUTOFF
  || (windowStart ? new Date(Date.parse(`${windowStart}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10) : '2012-01-01');

// MEMBERSHIP=lq45 → POINT-IN-TIME universe. The tradable set at every step is the index as it
// stood on that date (portfolio-app/data/index-members.json), not today's members, so the
// survivorship a TIER= run bakes in is gone. Needs a history file that prices every historical
// member — HISTORY_FILE=backtest-history-pit.json. MEMBERSHIP=<path> reads another archive.
const membershipPath = !process.env.MEMBERSHIP ? null
  : /^(1|lq45)$/i.test(process.env.MEMBERSHIP)
    ? join(__dirname, '..', '..', 'portfolio-app', 'data', 'index-members.json')
    : process.env.MEMBERSHIP;
const membership = membershipPath ? JSON.parse(readFileSync(membershipPath, 'utf8')) : null;

const known = new Map(data.tickers.map(t => [t.ticker, t]));
let universe, selectionLabel;
if (membership) {
  universe = pitUniverse(data, membership, windowStart);
  selectionLabel = `POINT-IN-TIME ${membership.index ?? 'index'} — ${universe.length} names ever a member from ${windowStart ?? 'the start of the archive'}`;
} else if (process.env.TIER) {
  // A universe TIER (core / lq45 / broad — see portfolio-app/data/universe.js), held to the
  // SAME listing cutoff the default path uses. That filter is not cosmetic: the engine starts
  // the walk at (newest listing among the included names + 1 year), so one 2025 listing would
  // collapse the entire window to nothing. Names the history file has never heard of are
  // dropped too — a tier is a label, and nothing guarantees Yahoo priced every one of them.
  const want = tierAtMost(process.env.TIER).map(toBare);
  const missing = want.filter(t => !known.has(t));
  const late = want.filter(t => known.has(t) && !(known.get(t).listing && known.get(t).listing <= LISTING_CUTOFF));
  universe = want.filter(t => known.has(t) && known.get(t).listing && known.get(t).listing <= LISTING_CUTOFF);
  selectionLabel = `TIER=${process.env.TIER} — ${universe.length} of ${want.length} names (listed ≤ ${LISTING_CUTOFF})`;
  if (missing.length) console.warn(`⚠️   not in ${historyPath.split('/').pop()}: ${missing.join(', ')}`
    + `\n     fetch them with: TIER=${process.env.TIER} npm run fetch -- --out public/<file>.json`);
  if (late.length) console.warn(`⚠️   dropped ${late.length} name(s) listed after ${LISTING_CUTOFF}: ${late.join(', ')}`
    + '\n     (each would push the walk start to its listing + 1 year)');
} else if (process.env.UNIVERSE) {
  const requested = process.env.UNIVERSE.split(',').map(s => s.trim().replace(/\.JK$/i, '')).filter(Boolean);
  const unknown = requested.filter(t => !known.has(t));
  if (unknown.length) {
    console.error(`❌  Not in backtest-history.json: ${unknown.join(', ')}\n    Run \`npm run fetch\` if the universe changed.`);
    process.exit(1);
  }
  universe = [...new Set(requested)];
  selectionLabel = `explicit selection (${universe.length} names)`;
} else {
  universe = data.tickers.filter(t => t.listing && t.listing <= LISTING_CUTOFF).map(t => t.ticker);
  selectionLabel = `${universe.length} long-history names (listed ≤ ${LISTING_CUTOFF})`;
}
if (universe.length < 2) { console.error(`❌  Need at least 2 names; got ${universe.length}.`); process.exit(1); }

// ── the grid ──────────────────────────────────────────────────────────────────
const PRIORS = (process.env.PRIORS || 'cap,shrunk,equal,none').split(',');
const VIEWSET = (process.env.VIEWSET || (views ? 'off,hybrid,analyst' : 'off')).split(',');
// Stage 1 holds τ fixed — sweeping it here would triple the grid to rank configs that
// mostly differ in a knob stage 2 can refine far more cheaply on the finalists alone.
const TAUS = (process.env.TAUS || '0.03').split(',').map(Number);
const REFINE_TAUS = (process.env.REFINE_TAUS || '0.01,0.03,0.10').split(',').map(Number);
const frequencies = (process.env.FREQS || 'weekly,monthly,quarterly').split(',');

const configs = [];
for (const priorMode of PRIORS) {
  for (const viewMode of VIEWSET) {
    if (viewMode !== 'off' && !views) continue;
    // τ only bites when a prior AND views both exist — otherwise it is a no-op axis and
    // sweeping it would just run identical backtests under different labels.
    const taus = (viewMode !== 'off' && priorMode !== 'none') ? TAUS : [null];
    for (const tau of taus) configs.push({ priorMode, viewMode, tau });
  }
}
const label = c => `${c.priorMode}/${c.viewMode}${c.tau != null ? `/τ${c.tau}` : ''}`;

// ── Search fidelity ──────────────────────────────────────────────────────────
// `paths` is a LINEAR cost lever and, for Max-Sharpe, a free one. The engine feeds the
// optimizer `paths` identical copies of μ, so avgMeans collapses to μ and Max-Sharpe is
// EXACT at any path count — measured invariant to 4 decimal places from paths=40 down to
// paths=4, while wall-clock fell 31.7s → 3.6s on the same grid. Only the CVaR tail term
// actually consumes paths, and it carries about ±0.03 Sharpe of estimation noise at
// paths=8. That is the whole justification for a cheap stage 1: rank on a signal that is
// either exact or noisy at a known, bounded scale, then re-verify the winner properly.
const paths = num('PATHS', 8);
const optimizeMaxIter = num('MAXITER', 20);   // the hill-climb converges well before 20
const kappaSweep = (process.env.KAPPAS || '0,0.25,0.5').split(',').map(Number);
const TRAIN_FRAC = num('TRAIN_FRAC', 0.6);
const VERIFY_PATHS = num('VERIFY_PATHS', 60); // stage 2 — full fidelity on the finalists
const TOP_N = num('TOP_N', 3);

// Stage 1 charts Max-Sharpe (exact) + ONE tail λ, because every extra λ is another full
// walk per config. The finalists get the complete λ set back in stage 2.
const searchLambdas = (process.env.LAMBDAS || '0.5').split(',').map(Number);
const searchVariants = [
  { key: 'MaxSharpe', label: 'Max-Sharpe', mode: 'avgMuSharpe', tailPenalty: 0 },
  ...searchLambdas.map(l => ({ key: `Tail${String(l).replace('.', '')}`, label: `Tail λ=${l}`, mode: 'tailAware', tailPenalty: l })),
];

console.log(`\n🔎  Config sweep — ${selectionLabel}`);
console.log(`    ${universe.join(', ')}\n`);
console.log(`    grid: ${configs.length} μ-configs × ${frequencies.length} freq × ${kappaSweep.length} κ × variants`);
console.log(`    fidelity: paths=${paths} maxIter=${optimizeMaxIter} (coarse; winner re-verified)`);
console.log(`    ranking: OUT-OF-SAMPLE — train on first ${(TRAIN_FRAC * 100).toFixed(0)}%, report the rest\n`);

// ── per-config evaluation ─────────────────────────────────────────────────────
/** Per-period net returns implied by an equity curve. */
const curveRets = eq => eq.slice(1).map((v, i) => (eq[i] > 0 ? v / eq[i] - 1 : 0));

/** Train/test Sharpe from a curve, split by index at TRAIN_FRAC. */
function splitSharpe(eq, rfAnnual, ppy) {
  const r = curveRets(eq);
  if (r.length < 10) return null;
  const cut = Math.floor(r.length * TRAIN_FRAC);
  const rfP = perPeriodRate(rfAnnual, ppy);
  return {
    train: sharpeFromExcess(r.slice(0, cut), rfP, ppy),
    test: sharpeFromExcess(r.slice(cut), rfP, ppy),
    nTrain: cut, nTest: r.length - cut,
  };
}

const PPY = { weekly: 52, monthly: 13, quarterly: 4 };
const riskCache = new Map();     // shared Σ across every config — the reason this is tractable
const rows = [];
const t0 = Date.now();

// ── checkpointing ─────────────────────────────────────────────────────────────
// A sweep is one long uninterruptible process that holds every result in memory and
// writes its artifact only at the very end, so a closed lid, an OOM or a dead battery
// costs the whole run. After each config we dump what we have to a sibling .ckpt.json.
//
// RESUME=1 reads that back and skips the configs already in it. The Σ riskCache is NOT
// persisted — it is hundreds of megabytes of per-step covariance and is rebuilt on the
// first surviving config — so a resume saves the optimizer walks, not the risk build.
//
// The FINGERPRINT guard is the part that matters: a checkpoint is only reused when the
// universe, the grid and the fidelity all match. Resuming across a changed universe
// would silently blend two different experiments into one ranked table.
const outPath = join(publicDir, process.env.OUTFILE || 'sweep-configs.json');
const ckptPath = outPath.replace(/\.json$/i, '') + '.ckpt.json';
const fingerprint = JSON.stringify({
  universe: [...universe].sort(), windowStart,
  pit: membership ? { index: membership.index ?? null, generated: membership.generated ?? null } : null,
  priors: PRIORS, views: VIEWSET, taus: TAUS, frequencies, kappaSweep,
  paths, optimizeMaxIter, trainFrac: TRAIN_FRAC, lambdas: searchLambdas,
});

const doneConfigs = new Set();   // stage-1 config labels already in hand
const doneFinalists = new Set(); // stage-2 "prior/view/freq/τ" keys already in hand
let resumed = null;

if (process.env.RESUME && existsSync(ckptPath)) {
  try {
    const ck = JSON.parse(readFileSync(ckptPath, 'utf8'));
    if (ck.fingerprint !== fingerprint) {
      console.warn(`⚠️   ${ckptPath.split('/').pop()} is from a DIFFERENT universe/grid — ignoring it.`
        + '\n     Delete it, or drop RESUME to start clean.');
    } else {
      resumed = ck;
      rows.push(...(ck.rows ?? []));
      for (const c of ck.doneConfigs ?? []) doneConfigs.add(c);
      for (const f of ck.doneFinalists ?? []) doneFinalists.add(f);
      console.log(`↻  Resuming from ${ckptPath.split('/').pop()} — `
        + `${doneConfigs.size}/${configs.length} configs and ${doneFinalists.size} finalist(s) already done`
        + ` (${(ck.elapsedSec ?? 0).toFixed(0)}s of prior compute kept).\n`);
    }
  } catch (e) {
    console.warn(`⚠️   Unreadable checkpoint ${ckptPath}: ${e.message} — starting clean.`);
  }
}

/** Dump everything gathered so far. Called after every config — cheap next to a walk. */
function saveCheckpoint(stage, verifiedSoFar = []) {
  try {
    writeFileSync(ckptPath, JSON.stringify({
      generated: new Date().toISOString(),
      complete: false, stage, fingerprint,
      universe, selectionLabel, windowStart,
      elapsedSec: (Date.now() - t0) / 1000 + (resumed?.elapsedSec ?? 0),
      doneConfigs: [...doneConfigs], doneFinalists: [...doneFinalists],
      rows, verified: verifiedSoFar,
    }));
  } catch (e) {
    console.warn(`⚠️   Could not write checkpoint: ${e.message}`);
  }
}

for (let i = 0; i < configs.length; i++) {
  const c = configs[i];
  if (doneConfigs.has(label(c))) {
    console.log(`  [${String(i + 1).padStart(2)}/${configs.length}] ${label(c).padEnd(22)} ↻ from checkpoint`);
    continue;
  }
  const res = runStrategyBacktest(data, universe, {
    frequencies, paths, optimizeMaxIter, seed: 12345, variants: searchVariants,
    kappaSweep, kappa: 0.25, tailPenalty: 0.5,
    priorMode: c.priorMode, viewMode: c.viewMode, views,
    ...(c.tau != null ? { factorConfig: { tau: c.tau } } : {}),
    windowStart, riskCache, ...(membership ? { membership } : {}),
  });
  if (!res.ok) { console.log(`  ${label(c).padEnd(22)} ✗ ${(res.warnings || []).join('; ')}`); continue; }

  for (const [freqKey, fb] of Object.entries(res.byFrequency)) {
    const ppy = PPY[freqKey] ?? 52;
    const rfA = res.window.riskFreeRate ?? data.riskFreeRate ?? 0.0575;
    for (const [stratKey, curve] of Object.entries(fb.curves)) {
      if (!curve?.netEq) continue;
      // Min-Var / Equal-Wt / IHSG never read μ, so they are identical across every config.
      // Keep them once (from the first config) as the baselines to beat.
      const isBaseline = ['MinVar', 'EqualWeight', 'IndexWeight', 'IHSG'].includes(stratKey);
      if (isBaseline && i > 0) continue;
      const sp = splitSharpe(curve.netEq, rfA, ppy);
      if (!sp) continue;
      const m = fb.metrics[stratKey] ?? {};
      // λ comes from the engine's own variant table — never re-derived from the key name
      // ('Tail10' means λ=1.0, not 0.10, and a regex got that wrong).
      const variant = res.params.variants.find(v => v.key === stratKey) ?? null;
      rows.push({
        config: isBaseline ? '—' : label(c),
        lambda: variant ? variant.tailPenalty : null,
        robustMode: variant ? variant.mode : null,
        priorMode: c.priorMode, viewMode: c.viewMode, tau: c.tau,
        freq: freqKey, strat: stratKey, isBaseline,
        train: sp.train, test: sp.test,
        full: m.sharpe ?? 0, gross: m.grossSharpe ?? 0,
        annReturn: m.annReturn ?? 0, annVol: m.annVol ?? 0,
        turnover: m.annualTurnover ?? 0, drag: m.annualCostDrag ?? 0,
        maxDD: m.maxDrawdown ?? 0, tStat: m.tStat ?? 0,
        coverage: res.params.viewCoverage?.[freqKey]?.coverage ?? null,
      });
    }
    // κ sweep rows (reference λ), so the turnover-penalty axis is searched too.
    for (const ks of fb.kappaSweep ?? []) {
      rows.push({
        config: label(c), priorMode: c.priorMode, viewMode: c.viewMode, tau: c.tau,
        freq: freqKey, strat: `Tail05@κ${ks.kappa}`, isBaseline: false, kappa: ks.kappa,
        train: null, test: null,
        full: ks.sharpe ?? 0, gross: ks.grossSharpe ?? 0,
        annReturn: ks.annReturn ?? 0, annVol: ks.annVol ?? 0,
        turnover: ks.annualTurnover ?? 0, drag: ks.annualCostDrag ?? 0,
        maxDD: ks.maxDrawdown ?? 0, tStat: ks.tStat ?? 0,
      });
    }
  }
  doneConfigs.add(label(c));
  saveCheckpoint('stage1');
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`  [${String(i + 1).padStart(2)}/${configs.length}] ${label(c).padEnd(22)} done  (${el}s elapsed)`);
}

// ── ranking ───────────────────────────────────────────────────────────────────
const ranked = rows.filter(r => !r.isBaseline && r.train != null).sort((a, b) => b.train - a.train);
const baselines = rows.filter(r => r.isBaseline);

const pct = v => `${(v * 100).toFixed(1)}%`;
const f2 = v => (v == null ? '  —  ' : v.toFixed(2).padStart(5));

console.log(`\n\n${'═'.repeat(112)}`);
console.log('RANKED BY TRAIN-SLICE NET SHARPE  (test = held-out later slice, the honest number)');
console.log('═'.repeat(112));
console.log(`${'config'.padEnd(22)}${'freq'.padEnd(11)}${'variant'.padEnd(12)}${'train'.padStart(7)}${'test'.padStart(7)}${'full'.padStart(7)}${'gross'.padStart(7)}${'turn'.padStart(8)}${'drag'.padStart(8)}${'cov'.padStart(7)}`);
console.log('─'.repeat(112));
for (const r of ranked.slice(0, 25)) {
  console.log(
    r.config.padEnd(22) + r.freq.padEnd(11) + r.strat.padEnd(12) +
    f2(r.train).padStart(7) + f2(r.test).padStart(7) + f2(r.full).padStart(7) + f2(r.gross).padStart(7) +
    `${r.turnover.toFixed(1)}×`.padStart(8) + pct(r.drag).padStart(8) +
    (r.coverage != null ? pct(r.coverage) : '—').padStart(7));
}

console.log(`\n${'─'.repeat(112)}\nBASELINES (μ-independent — identical under every config)`);
for (const b of baselines.sort((x, y) => y.train - x.train)) {
  console.log(`${'—'.padEnd(22)}${b.freq.padEnd(11)}${b.strat.padEnd(12)}${f2(b.train).padStart(7)}${f2(b.test).padStart(7)}${f2(b.full).padStart(7)}${f2(b.gross).padStart(7)}`);
}

// ── stage 2: refine the finalists at full fidelity ────────────────────────────
// Stage 1 ranked on a cheap signal (exact for Max-Sharpe, ±0.03 for tails) with τ pinned
// and one λ. Take the top few DISTINCT (prior, view) pairs, restore the full λ set and the
// τ axis, and re-run them properly. This is where a recommendation is actually earned —
// stage 1 only decided who gets the compute.
const seen = new Set();
const finalists = [];
for (const r of ranked) {
  if (finalists.length >= TOP_N) break;   // TOP_N=0 skips stage 2 entirely
  const k = `${r.priorMode}/${r.viewMode}`;
  if (seen.has(k)) continue;
  seen.add(k);
  finalists.push(r);
  if (finalists.length >= TOP_N) break;
}

console.log(`\n\n${'═'.repeat(112)}`);
console.log(`STAGE 2 — re-verifying ${finalists.length} finalist(s) at paths=${VERIFY_PATHS}, full λ set, τ sweep`);
console.log('═'.repeat(112));

const verified = [...(resumed?.verified ?? [])];
for (const f of finalists) {
  const taus = (f.viewMode !== 'off' && f.priorMode !== 'none') ? REFINE_TAUS : [null];
  for (const tau of taus) {
    const fkey = `${f.priorMode}/${f.viewMode}/${f.freq}/τ${tau}`;
    if (doneFinalists.has(fkey)) continue;
    const res = runStrategyBacktest(data, universe, {
      frequencies: [f.freq], paths: VERIFY_PATHS, optimizeMaxIter, seed: 12345,
      kappaSweep, kappa: 0.25, tailPenalty: 0.5,
      priorMode: f.priorMode, viewMode: f.viewMode, views,
      ...(tau != null ? { factorConfig: { tau } } : {}),
      windowStart, riskCache, ...(membership ? { membership } : {}),
    });
    if (!res.ok) continue;
    const fb = res.byFrequency[f.freq];
    const ppy = PPY[f.freq] ?? 52;
    const rfA = res.window.riskFreeRate ?? data.riskFreeRate ?? 0.0575;
    for (const [stratKey, curve] of Object.entries(fb.curves)) {
      if (!curve?.netEq || ['MinVar', 'EqualWeight', 'IndexWeight', 'IHSG'].includes(stratKey)) continue;
      const sp = splitSharpe(curve.netEq, rfA, ppy);
      if (!sp) continue;
      const m = fb.metrics[stratKey] ?? {};
      const variant = res.params.variants.find(v => v.key === stratKey) ?? null;
      verified.push({
        config: `${f.priorMode}/${f.viewMode}${tau != null ? `/τ${tau}` : ''}`,
        priorMode: f.priorMode, viewMode: f.viewMode, tau,
        freq: f.freq, strat: stratKey,
        lambda: variant ? variant.tailPenalty : null,
        robustMode: variant ? variant.mode : null,
        train: sp.train, test: sp.test,
        full: m.sharpe ?? 0, gross: m.grossSharpe ?? 0,
        annReturn: m.annReturn ?? 0, annVol: m.annVol ?? 0,
        turnover: m.annualTurnover ?? 0, drag: m.annualCostDrag ?? 0,
        maxDD: m.maxDrawdown ?? 0, tStat: m.tStat ?? 0,
        coverage: res.params.viewCoverage?.[f.freq]?.coverage ?? null,
      });
    }
    doneFinalists.add(fkey);
    saveCheckpoint('stage2', verified);
  }
  console.log(`  ${(`${f.priorMode}/${f.viewMode}`).padEnd(22)} ${f.freq.padEnd(11)} verified  (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
}

verified.sort((a, b) => b.train - a.train);
console.log(`\n${'config'.padEnd(22)}${'freq'.padEnd(11)}${'variant'.padEnd(12)}${'train'.padStart(7)}${'test'.padStart(7)}${'full'.padStart(7)}${'gross'.padStart(7)}${'turn'.padStart(8)}${'drag'.padStart(8)}`);
console.log('─'.repeat(112));
for (const v of verified.slice(0, 20)) {
  console.log(v.config.padEnd(22) + v.freq.padEnd(11) + v.strat.padEnd(12) +
    f2(v.train).padStart(7) + f2(v.test).padStart(7) + f2(v.full).padStart(7) + f2(v.gross).padStart(7) +
    `${v.turnover.toFixed(1)}×`.padStart(8) + pct(v.drag).padStart(8));
}

// ── the recommendation ────────────────────────────────────────────────────────
// NOT the argmax. Picking the single best train cell out of ~60 reliably selects a spike:
// on the reference run the top cell scored train 0.79 / test −0.11, while its own family
// (same signal, frequency and objective, averaged over priors and τ) scored a far more
// believable train 0.62 / test −0.07.
//
// So the recommendation is the best FAMILY — (viewMode, frequency, objective) averaged
// across every prior and τ — and the family's spread doubles as the robustness statistic.
// A family whose members agree (low sd) is a plateau you can stand on; a family that only
// looks good through one member is a coincidence.
const FAMILY_MIN = 3;
const families = {};
for (const v of [...verified, ...ranked]) {
  if (v.train == null) continue;
  const k = `${v.viewMode}|${v.freq}|${v.strat}`;
  (families[k] ??= []).push(v);
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const famRows = Object.entries(families)
  .filter(([, v]) => v.length >= FAMILY_MIN)
  .map(([k, v]) => ({
    key: k, n: v.length, members: v,
    trainM: mean(v.map(x => x.train)), trainSd: sd(v.map(x => x.train)),
    testM: mean(v.map(x => x.test)), fullM: mean(v.map(x => x.full)),
    ddM: mean(v.map(x => x.maxDD)), turnM: mean(v.map(x => x.turnover)),
  }))
  .sort((a, b) => b.fullM - a.fullM);

// Baseline decay is the control. Min-Var and Equal-Wt never read μ, so whatever they lose
// from train to test is the REGIME changing underfoot, not a config being over-fitted.
// Only the excess over that is evidence of grid-mining.
const baseDecay = baselines.length ? mean(baselines.map(b => b.train - b.test)) : 0;

if (famRows.length) {
  console.log(`\n${'═'.repeat(112)}\nCONFIG FAMILIES — averaged over priors and τ (a tight family is a PLATEAU)\n${'═'.repeat(112)}`);
  console.log(`${'signal | freq | objective'.padEnd(36)}${'n'.padStart(3)}${'trainM'.padStart(8)}${'sd'.padStart(7)}${'testM'.padStart(8)}${'fullM'.padStart(8)}${'maxDD'.padStart(7)}${'turn'.padStart(7)}`);
  console.log('─'.repeat(112));
  for (const f of famRows.slice(0, 12)) {
    console.log(f.key.padEnd(36) + String(f.n).padStart(3) + f.trainM.toFixed(2).padStart(8) +
      f.trainSd.toFixed(2).padStart(7) + f.testM.toFixed(2).padStart(8) + f.fullM.toFixed(2).padStart(8) +
      `${(f.ddM * 100).toFixed(0)}%`.padStart(7) + `${f.turnM.toFixed(1)}×`.padStart(7));
  }
}

// Representative member of the winning family: prefer the INCUMBENT settings (cap prior,
// τ=0.03) so the recommendation is "keep what you have, change what matters" rather than
// an arbitrary member. Falls back to the family's median-train member.
const champion = famRows[0] ?? null;
let best;
if (champion) {
  const byTrain = [...champion.members].sort((a, b) => a.train - b.train);
  best = champion.members.find(m => m.priorMode === 'cap' && (m.tau == null || m.tau === 0.03))
    ?? champion.members.find(m => m.priorMode === 'cap')
    ?? byTrain[Math.floor(byTrain.length / 2)];
  best = { ...best, family: champion };
} else {
  best = verified[0] ?? ranked[0];
}
const bestBase = baselines.filter(b => b.strat !== 'IHSG').sort((a, b) => b.test - a.test)[0];

console.log(`\n${'═'.repeat(112)}\nRECOMMENDATION\n${'═'.repeat(112)}`);
if (!best) {
  console.log('  No config produced a rankable result.');
} else {
  const decay = best.train - best.test;
  const excess = decay - baseDecay;   // decay ABOVE what the μ-free baselines also lost
  if (best.family) {
    console.log(`  Best FAMILY : ${best.family.key}    (${best.family.n} configs, train sd ${best.family.trainSd.toFixed(2)})`);
    console.log(`    family train ${best.family.trainM.toFixed(3)} · test ${best.family.testM.toFixed(3)} · full-window ${best.family.fullM.toFixed(3)} · maxDD ${pct(best.family.ddM)}`);
    console.log(`    ${best.family.trainSd < 0.06
      ? 'TIGHT — members agree across every prior and τ, so this is a plateau, not one lucky cell.'
      : 'LOOSE — members disagree; the family average is carried by a few cells. Treat with care.'}`);
    console.log(`\n  Representative config : ${best.config}  ·  ${best.freq}  ·  ${best.strat}`);
  } else {
    console.log(`  Best on TRAIN : ${best.config}  ·  ${best.freq}  ·  ${best.strat}`);
  }
  console.log(`    train Sharpe ${best.train.toFixed(3)}   →   test Sharpe ${best.test.toFixed(3)}   (decay ${decay >= 0 ? '−' : '+'}${Math.abs(decay).toFixed(3)})`);
  console.log(`    baselines decayed ${baseDecay.toFixed(3)} over the same split — they read no μ, so that much is REGIME, not fit.`);
  console.log(`    excess decay attributable to config choice: ${excess >= 0 ? '' : '+'}${(-excess).toFixed(3)}`);
  console.log(`    ann ${pct(best.annReturn)} · vol ${pct(best.annVol)} · turnover ${best.turnover.toFixed(1)}× · drag ${pct(best.drag)} · maxDD ${pct(best.maxDD)} · t=${best.tStat.toFixed(2)}`);
  if (bestBase) {
    const beats = best.test > bestBase.test;
    console.log(`\n  vs best baseline (${bestBase.strat} ${bestBase.freq}): test ${bestBase.test.toFixed(3)}`);
    console.log(`    → the searched config ${beats ? 'BEATS' : 'DOES NOT BEAT'} the naive baseline out-of-sample.`);
    if (!beats) console.log('      Treat the ranking as descriptive, not as a setting to deploy.');
  }
  if (excess > 0.15) {
    console.log(`\n  ⚠️  Decay runs ${excess.toFixed(2)} BEYOND the baselines' own decay — that excess is the`);
    console.log('      grid-mining signature. Prefer a tighter family than this one.');
  } else if (decay > 0.3) {
    console.log(`\n  ℹ️  The large raw decay (${decay.toFixed(2)}) is COMMON-MODE: the μ-free baselines lost`);
    console.log(`      ${baseDecay.toFixed(2)} over the same split, so it is the regime differing between the train`);
    console.log('      and test periods, not this config being over-fitted. Compare configs to each');
    console.log('      other on the test slice, not against zero.');
  }
  if (Math.abs(best.tStat) < 2) {
    console.log(`\n  ⚠️  t = ${best.tStat.toFixed(2)}: this result is not statistically distinguishable from zero.`);
    console.log('      Every config in this grid is in the same position. Read the table as a map of');
    console.log('      where the machinery behaves sensibly, not as evidence that one setting wins.');
  }

  console.log(`\n${'─'.repeat(112)}\n  CARRY BACK INTO THE OPTIMIZER (portfolio-app)\n${'─'.repeat(112)}`);
  const usesBL = best.viewMode !== 'off' && best.priorMode !== 'none';
  console.log('  optimizer-config.json:');
  console.log(`    "factorConfig": { "useFactorModel": ${usesBL}, "useBlackLitterman": ${usesBL},`);
  console.log(`                      "useCapPrior": ${best.priorMode === 'cap'}, "useAnalystViews": ${best.viewMode !== 'off'}`);
  if (best.tau != null) console.log(`                      , "tau": ${best.tau}`);
  console.log('                    }');
  const lamVal = best.lambda ?? 0;
  const mode = best.robustMode === 'avgMuSharpe' ? '"avgMuSharpe"' : '"tailAware"';
  console.log(`    "simConfig":    { "robustMode": ${mode}, "tailPenalty": ${lamVal} }`);
  console.log('\n  optimize.mjs flags:');
  console.log(`    --methodology ${usesBL ? 'bl' : 'pert'} --prior-mode ${best.priorMode === 'none' ? 'cap' : best.priorMode}${best.tau != null ? ` --tau ${best.tau}` : ''}`);
  console.log(`\n  rebalance frequency: ${best.freq}`);
  console.log('\n  ⚠️  The backtest scores a SIGNAL-FREE or archive-driven μ; the live optimizer runs the');
  console.log('      PERT-from-targets distribution on TODAY\'s targets. These settings transfer the');
  console.log('      structure (prior, τ, λ, frequency), not a claim about live alpha.');
}

// ── artifact ──────────────────────────────────────────────────────────────────
// outPath was hoisted up beside the checkpoint machinery.
writeFileSync(outPath, JSON.stringify({
  generated: new Date().toISOString(),
  universe, selectionLabel, windowStart,
  grid: { priors: PRIORS, views: VIEWSET, taus: TAUS, frequencies, kappaSweep },
  fidelity: { paths, optimizeMaxIter, trainFrac: TRAIN_FRAC },
  ranked: ranked.slice(0, 60), allRanked: ranked, verified, baselines,   // allRanked: no truncation — family/signal comparisons need the LOW-train cells too
  families: famRows.map(({ members, ...f }) => f), baselineDecay: baseDecay,
  recommendation: best ?? null,
}, null, 2));
// The run completed, so the checkpoint has nothing left to protect. Removing it also
// stops a later RESUME from silently short-circuiting a fresh run of the same grid.
try { if (existsSync(ckptPath)) unlinkSync(ckptPath); } catch { /* leaving it is harmless */ }

console.log(`\n📦  ${outPath}   (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
