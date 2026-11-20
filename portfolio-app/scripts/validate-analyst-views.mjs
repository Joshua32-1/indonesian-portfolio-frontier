/**
 * validate-analyst-views.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Offline regression suite for the analyst-target archive and its pure lookups.
 * No network. Mirrors validate-bi-rate.mjs in spirit: the look-ahead guard is the
 * safety-critical property here — a view-driven backtest is only honest if a lookup
 * at time t can never see a target published after t.
 *
 * Usage:  node scripts/validate-analyst-views.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  idxAsOf, daysBetweenISO, viewAsOf, makeViewLookup, coverageOver,
  DEFAULT_MAX_STALENESS_DAYS, DEFAULT_MAX_Q, DEFAULT_STABILITY,
} from '../data/analyst-views.js';
import {
  CORE_TIER_JK, LQ45_ADDITIONS_JK, BROAD_ADDITIONS_JK, EXTENDED_UNIVERSE_JK,
  UNIVERSE_TIERS, tierOf, tierAtMost, toBare,
} from '../data/universe.js';
import { ttmYieldAsOf, makeYieldLookup, shiftISO, DEFAULT_WINDOW_DAYS } from '../data/dividends.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const archivePath = join(__dirname, '..', 'data', 'analyst-views.json');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const section = t => console.log(`\n── ${t} ──`);

// ── 1. idxAsOf ────────────────────────────────────────────────────────────────
section('idxAsOf (binary search, as-of semantics)');
const D = ['2020-01-01', '2020-01-08', '2020-01-15', '2020-01-22'];
ok('exact match returns that index', idxAsOf(D, '2020-01-15') === 2);
ok('between rows returns the EARLIER row', idxAsOf(D, '2020-01-20') === 2); // 01-15, not 01-22
ok('before the first row returns -1', idxAsOf(D, '2019-12-31') === -1);
ok('after the last row returns the last index', idxAsOf(D, '2026-01-01') === 3);
ok('first row exact', idxAsOf(D, '2020-01-01') === 0);
ok('empty array returns -1', idxAsOf([], '2020-01-01') === -1);
ok('daysBetweenISO', daysBetweenISO('2020-01-01', '2020-01-08') === 7);
ok('daysBetweenISO is signed', daysBetweenISO('2020-01-08', '2020-01-01') === -7);

// ── 2. synthetic archive: staleness + total-return math ───────────────────────
section('viewAsOf (staleness, Q construction)');
const synth = {
  tickers: {
    AAA: {
      static: { dividendYield: 0.04, totalAnalysts: 10, dispersion: 0.2 },
      targets: { dates: ['2020-01-01', '2020-06-01'], target: [120, 150], price: [100, 100] },
      enrich: [{ d: '2020-05-01', analysts: 7, dispersion: 0.5 }],
    },
  },
};
const v1 = viewAsOf(synth, 'AAA', '2020-01-01');
ok('upside = (target − price)/price', v1 && Math.abs(v1.upside - 0.2) < 1e-12);
ok('totalReturn adds the dividend yield', v1 && Math.abs(v1.totalReturn - 0.24) < 1e-12);
ok('ageDays 0 on an exact hit', v1 && v1.ageDays === 0);
ok('unknown ticker → null', viewAsOf(synth, 'ZZZ', '2020-01-01') === null);
ok('date before archive start → null', viewAsOf(synth, 'AAA', '2019-01-01') === null);

const stale = viewAsOf(synth, 'AAA', '2020-04-01');           // 91 days after the 2020-01-01 row
ok('within staleness window resolves', stale !== null && stale.date === '2020-01-01');
ok('beyond staleness window → null',
  viewAsOf(synth, 'AAA', '2020-04-01', { maxStalenessDays: 30 }) === null);
ok('staleness boundary is inclusive',
  viewAsOf(synth, 'AAA', '2020-04-01', { maxStalenessDays: 91 }) !== null);

const enriched = viewAsOf(synth, 'AAA', '2020-06-01');
ok('dated enrichment overrides the static fallback',
  enriched && enriched.analysts === 7 && Math.abs(enriched.dispersion - 0.5) < 1e-12);
const preEnrich = viewAsOf(synth, 'AAA', '2020-01-01');
ok('before any enrichment, the static fallback is used',
  preEnrich && preEnrich.analysts === 10 && Math.abs(preEnrich.dispersion - 0.2) < 1e-12);

// ── 2a2. Q clamp and the consensus-quality gate ───────────────────────────────
section('Q clamp + consensus-quality gate');
const mkS = (t, p) => ({ tickers: { X: { static: { dividendYield: 0 }, targets: {
  dates: t.map((_, i) => `2020-01-${String(i + 1).padStart(2, '0')}`), target: t, price: p } } } });

const rising = mkS(Array.from({ length: 20 }, (_, i) => 1000 + i), Array(20).fill(100));
const cl = viewAsOf(rising, 'X', '2020-01-20', { stability: null });
ok('an absurd view is CLAMPED, not dropped', cl && cl.totalReturn === DEFAULT_MAX_Q);
ok('the unclamped value is preserved for audit', cl && cl.totalReturnRaw > DEFAULT_MAX_Q);
ok('the clamp is flagged', cl && cl.clamped === true);
const modest = mkS(Array.from({ length: 20 }, (_, i) => 120 + i * 0.5), Array(20).fill(100));
const mv = viewAsOf(modest, 'X', '2020-01-20');
ok('a plausible view is NOT clamped', mv && mv.clamped === false && Math.abs(mv.totalReturn - 0.295) < 0.02);

// FROZEN — target abandoned while the price moved (the MNCN failure mode).
const frozen = mkS(Array(20).fill(1300), Array(20).fill(200));
ok('a FROZEN consensus is gated', viewAsOf(frozen, 'X', '2020-01-20') === null);
ok('…and returns a view when the gate is disabled',
  viewAsOf(frozen, 'X', '2020-01-20', { stability: null }) !== null);

// JUMPY — a single revision moves the whole "consensus" (one- or two-analyst coverage).
const jumpy = mkS([...Array(12).fill(100), ...Array(8).fill(180)], Array(20).fill(100));
ok('a JUMPY consensus is gated', viewAsOf(jumpy, 'X', '2020-01-20') === null);

ok('a healthy consensus passes both gates', mv !== null && mv.frozenFrac < 0.9 && mv.maxJump < 0.25);
ok('quality diagnostics are reported', mv && mv.frozenFrac != null && mv.maxJump != null);

// The gate must not peek: quality is judged only on prints at or before the lookup date.
// The series must be otherwise HEALTHY (drifting, not frozen) or the frozen rule fires
// first and the test proves nothing about look-ahead.
const lateJump = mkS([...Array.from({ length: 19 }, (_, i) => 100 + i), 500], Array(20).fill(100));
ok('the gate reads no print after the lookup date',
  viewAsOf(lateJump, 'X', '2020-01-19') !== null && viewAsOf(lateJump, 'X', '2020-01-20') === null);
ok('defaults are exported', DEFAULT_MAX_Q === 2 && DEFAULT_STABILITY.window === 26);

// ── 2b. dated dividend yield ──────────────────────────────────────────────────
section('dividends (dated TTM yield, look-ahead guard)');
const DIV = { tickers: { AAA: { events: [
  { d: '2019-01-10', y: 0.02 }, { d: '2019-07-10', y: 0.03 }, { d: '2020-02-10', y: 0.04 },
] } } };
ok('sums only the trailing window', Math.abs(ttmYieldAsOf(DIV, 'AAA', '2019-12-31') - 0.05) < 1e-12);
ok('an ex-date exactly on asOf COUNTS', Math.abs(ttmYieldAsOf(DIV, 'AAA', '2019-01-10') - 0.02) < 1e-12);
ok('an ex-date one day AFTER asOf does not', ttmYieldAsOf(DIV, 'AAA', '2019-01-09') === 0);
ok('events roll OUT after the window',
  Math.abs(ttmYieldAsOf(DIV, 'AAA', '2020-02-10') - 0.07) < 1e-12);   // 2019-01-10 has rolled out
ok('window edge is half-open on the left',
  ttmYieldAsOf(DIV, 'AAA', shiftISO('2019-01-10', DEFAULT_WINDOW_DAYS)) === 0.03);
ok('unknown ticker yields 0', ttmYieldAsOf(DIV, 'ZZZ', '2020-01-01') === 0);
const ylk = makeYieldLookup(DIV);
ok('lookup surface', ylk.has('AAA') && !ylk.has('ZZZ') && ylk.windowDays === DEFAULT_WINDOW_DAYS);

// The Q-side wiring: a dated series must WIN over the static snapshot value.
const dq = {
  tickers: {
    AAA: {
      static: { dividendYield: 0.09 },                     // the stale present-day number
      targets: { dates: ['2020-01-01'], target: [110], price: [100] },
      div: [{ d: '2019-06-01', y: 0.01 }, { d: '2015-01-01', y: 0.50 }],
    },
    BBB: {                                                  // no dated series ⇒ fallback
      static: { dividendYield: 0.09 },
      targets: { dates: ['2020-01-01'], target: [110], price: [100] },
    },
  },
};
const dated = viewAsOf(dq, 'AAA', '2020-01-01');
ok('dated yield overrides the static value',
  dated && Math.abs(dated.dividendYield - 0.01) < 1e-12 && dated.dividendSource === 'dated');
ok('Q = upside + DATED y', dated && Math.abs(dated.totalReturn - 0.11) < 1e-12);
ok('an out-of-window dividend is excluded from Q', dated && dated.dividendYield < 0.5);
const fb = viewAsOf(dq, 'BBB', '2020-01-01');
ok('static fallback still works when no series exists',
  fb && Math.abs(fb.dividendYield - 0.09) < 1e-12 && fb.dividendSource === 'static');

// ── 3. the real archive ───────────────────────────────────────────────────────
if (!existsSync(archivePath)) {
  console.log('\n⚠️   data/analyst-views.json not found — skipping live-archive checks.');
  console.log('     Build it with: node scripts/import-analyst-views.mjs');
} else {
  const A = JSON.parse(readFileSync(archivePath, 'utf8'));
  const tickers = Object.keys(A.tickers ?? {});

  section(`archive integrity (${tickers.length} tickers)`);
  let badOrder = [], badLen = [], badVal = [], dupes = [];
  for (const tk of tickers) {
    const { dates, target, price } = A.tickers[tk].targets;
    if (!(dates.length === target.length && dates.length === price.length)) badLen.push(tk);
    for (let i = 1; i < dates.length; i++) {
      if (dates[i] < dates[i - 1]) { badOrder.push(tk); break; }
      if (dates[i] === dates[i - 1]) { dupes.push(tk); break; }
    }
    if (target.some(v => !(v > 0)) || price.some(v => !(v > 0))) badVal.push(tk);
  }
  ok('parallel arrays are the same length', badLen.length === 0, badLen.join(', '));
  ok('dates are strictly ASCENDING (binary search precondition)', badOrder.length === 0, badOrder.join(', '));
  ok('no duplicate dates within a ticker', dupes.length === 0, dupes.join(', '));
  ok('every target and price is positive', badVal.length === 0, badVal.join(', '));
  ok('coverage block present', Boolean(A.coverage?.start && A.coverage?.end && A.coverage?.perTicker));
  ok('documented approximations are recorded', Array.isArray(A.notes) && A.notes.length > 0);

  // ── embedded dividend series ────────────────────────────────────────────────
  section('archive dividend series');
  const withDiv = tickers.filter(tk => A.tickers[tk].div?.length);
  let divOrder = [], divRange = [];
  for (const tk of withDiv) {
    const d = A.tickers[tk].div;
    for (let i = 1; i < d.length; i++) if (d[i].d < d[i - 1].d) { divOrder.push(tk); break; }
    if (d.some(e => !(e.y > 0) || e.y > 0.4)) divRange.push(tk);
  }
  ok(`dividend series are ASCENDING (${withDiv.length} names carry one)`, divOrder.length === 0, divOrder.join(', '));
  ok('every stored yield is in (0, 0.4]', divRange.length === 0, divRange.join(', '));
  ok('the dated series reaches most of the archive', withDiv.length > tickers.length * 0.7,
    `${withDiv.length}/${tickers.length}`);

  // THE bug this replaced: a name with a real dividend history silently using y = 0.
  // A zero yield is only legitimate for a genuine non-payer, so the invariant is
  // "every ticker with events in dividends.json carries them in the archive" — not
  // "nobody has a zero yield", which would wrongly flag GOTO, BUKA and friends.
  const divPath = join(__dirname, '..', 'data', 'dividends.json');
  if (existsSync(divPath)) {
    const DV = JSON.parse(readFileSync(divPath, 'utf8'));
    const payers = Object.entries(DV.tickers ?? {})
      .filter(([, r]) => (r.events ?? []).length > 0).map(([tk]) => tk);
    const dropped = payers.filter(tk => A.tickers[tk] && !A.tickers[tk].div?.length);
    ok(`every dividend payer's series reached the archive (${payers.length} payers)`,
      dropped.length === 0, dropped.join(', '));

    const lookY = makeViewLookup(A);   // `look` is bound later, in the look-ahead section
    const wrongZero = payers.filter(tk => {
      const v = A.tickers[tk] && lookY(tk, A.coverage.end);
      return v && v.dividendSource === 'none';
    });
    ok('no PAYER falls through to a zero-source yield', wrongZero.length === 0, wrongZero.join(', '));

    const nonPayers = Object.keys(A.tickers).filter(tk => !A.tickers[tk].div?.length);
    ok(`non-payers correctly carry no series (${nonPayers.length}: ${nonPayers.slice(0, 8).join(', ')})`,
      nonPayers.every(tk => !(DV.tickers?.[tk]?.events ?? []).length));
  } else {
    console.log('  ⚠️   data/dividends.json not found — skipping the fold-through check.');
  }

  // ── the gate must be walk-forward, PROVEN by truncation ─────────────────────
  // Reading the code is not evidence. Rebuild the archive as it stood on each probe date —
  // nothing after it exists at all — and require an identical verdict. Only the TARGET
  // series is truncated: div/enrich carry their own as-of windows (tested above), and
  // emptying them here would flip the static-yield fallback and manufacture differences
  // that have nothing to do with look-ahead.
  section('gate + clamp are walk-forward (truncate-and-compare)');
  const truncTargets = (rec, d) => {
    const { dates: dd, target: tt, price: pp } = rec.targets;
    let n = 0; while (n < dd.length && dd[n] <= d) n++;
    return { ...rec, targets: { dates: dd.slice(0, n), target: tt.slice(0, n), price: pp.slice(0, n) } };
  };
  let wfChecked = 0, wfBad = 0, wfEx = [];
  for (const tk of tickers) {
    const dd = A.tickers[tk].targets.dates;
    for (let i = 30; i < dd.length; i += 23) {
      const d = dd[i];
      const full = viewAsOf(A, tk, d);
      const tr = viewAsOf({ tickers: { [tk]: truncTargets(A.tickers[tk], d) } }, tk, d);
      wfChecked++;
      const same = (full === null && tr === null)
        || (full && tr && Math.abs(full.totalReturn - tr.totalReturn) < 1e-12 && full.clamped === tr.clamped);
      if (!same) { wfBad++; if (wfEx.length < 5) wfEx.push(`${tk} ${d}`); }
    }
  }
  ok(`identical verdict on a truncated archive (${wfChecked.toLocaleString('en-US')} probes)`,
    wfBad === 0, wfEx.join(', '));

  // ── universe tiers ──────────────────────────────────────────────────────────
  section('universe tiers (core / lq45 / broad)');
  const tiersSeen = tickers.map(tk => A.tickers[tk].tier);
  ok('every ticker carries a known tier',
    tiersSeen.every(t => UNIVERSE_TIERS.includes(t)),
    tickers.filter(tk => !UNIVERSE_TIERS.includes(A.tickers[tk].tier)).join(', '));
  ok('the archive tier matches data/universe.js',
    tickers.every(tk => A.tickers[tk].tier === tierOf(tk)),
    tickers.filter(tk => A.tickers[tk].tier !== tierOf(tk)).join(', '));

  const tierLists = [CORE_TIER_JK, LQ45_ADDITIONS_JK, BROAD_ADDITIONS_JK].map(l => l.map(toBare));
  const flat = tierLists.flat();
  ok('tier lists are DISJOINT (a ticker is listed once)', new Set(flat).size === flat.length,
    flat.filter((t, i) => flat.indexOf(t) !== i).join(', '));
  ok('tierAtMost nests: core ⊆ lq45 ⊆ broad',
    tierAtMost('core').length === CORE_TIER_JK.length
    && tierAtMost('lq45').length === CORE_TIER_JK.length + LQ45_ADDITIONS_JK.length
    && tierAtMost('broad').length === EXTENDED_UNIVERSE_JK.length);

  const missing = EXTENDED_UNIVERSE_JK.map(toBare).filter(t => !A.tickers[t]);
  ok('every tier ticker is present in the archive', missing.length === 0, missing.join(', '));

  const byTier = A.coverage?.byTier ?? {};
  const recount = {};
  for (const tk of tickers) recount[A.tickers[tk].tier] = (recount[A.tickers[tk].tier] ?? 0) + 1;
  ok('coverage.byTier counts match the ticker map',
    UNIVERSE_TIERS.every(t => (byTier[t]?.tickers ?? 0) === (recount[t] ?? 0)),
    JSON.stringify(recount));

  // The core tier is a frozen archive label (CORE_TIER_JK), decoupled from the editable
  // research list UNIVERSE_JK — so a research-universe edit can never relabel the archive.
  const coreArchive = tickers.filter(tk => A.tickers[tk].tier === 'core').sort();
  ok('tier=core is exactly CORE_TIER_JK',
    coreArchive.join(',') === CORE_TIER_JK.map(toBare).sort().join(','));

  // ── THE look-ahead guard: exhaustive over every (ticker × row) boundary ──────
  section('look-ahead guard (exhaustive)');
  const look = makeViewLookup(A);
  let violations = 0, checked = 0, boundaryOk = 0;
  for (const tk of tickers) {
    const { dates } = A.tickers[tk].targets;
    for (let i = 0; i < dates.length; i++) {
      // Probe ON the row date and the day BEFORE it — the day before must never
      // resolve to row i (that would be tomorrow's target used today).
      const on = look(tk, dates[i]);
      checked++;
      if (on && on.date > dates[i]) violations++;
      const dayBefore = new Date(Date.parse(`${dates[i]}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const before = look(tk, dayBefore);
      checked++;
      if (before && before.date > dayBefore) violations++;
      if (before && before.date === dates[i]) violations++; else boundaryOk++;
    }
  }
  ok(`no lookup returns a future row (${checked.toLocaleString('en-US')} probes)`, violations === 0,
    `${violations} violation(s)`);
  ok('the day before a publication never sees it', boundaryOk > 0 && violations === 0);

  section('lookup surface');
  ok('.has() is true for an archived ticker', look.has(tickers[0]) === true);
  ok('.has() is false for an unknown ticker', look.has('NOPE') === false);
  ok('.tickers lists the archive', Array.isArray(look.tickers) && look.tickers.length === tickers.length);
  ok('default staleness is exposed', look.maxStalenessDays === DEFAULT_MAX_STALENESS_DAYS);

  const grid = ['2018-01-05', '2020-06-05', '2023-03-03', '2026-08-21'];
  const cov = coverageOver(A, tickers.slice(0, 5), grid);
  ok('coverageOver counts cells correctly', cov.cells === 5 * grid.length);
  ok('coverage is a fraction in [0,1]', cov.coverage >= 0 && cov.coverage <= 1);
  ok('coverage matches the covered count', Math.abs(cov.coverage - cov.covered / cov.cells) < 1e-12);

  section('sanity: Q is a plausible total return');
  // Tier-aware on purpose. An implausible Q on a name you might actually trade is a data
  // error worth failing on. On a `historical` name it is usually REAL: analysts stop
  // revising targets as a stock collapses, so a stale 1300 target sits against a 200 price
  // and implies +550%. Failing on that would train us to silence the signal rather than
  // notice it — so it is reported loudly and separately instead.
  const extremeAt = tier => tickers.filter(tk => {
    if (A.tickers[tk].tier !== tier) return false;
    const v = look(tk, A.coverage.end);
    return v && (v.totalReturn < -0.9 || v.totalReturn > 5);
  }).map(tk => `${tk} ${(look(tk, A.coverage.end).totalReturn * 100).toFixed(0)}%`);

  const liveExtreme = ['core', 'lq45', 'broad'].flatMap(extremeAt);
  ok('no |Q| outside (−90%, +500%) among LIVE-universe names', liveExtreme.length === 0,
    liveExtreme.join(', '));

  const histExtreme = extremeAt('historical');
  console.log(histExtreme.length
    ? `  ℹ️  ${histExtreme.length} historical name(s) carry an extreme Q at the archive end: ${histExtreme.join(', ')}`
    : '  ℹ️  no historical name carries an extreme Q at the archive end');

  // THE calibration statistic: how often does the consensus imply >200% upside, by tier?
  // A monotone rise toward `historical` means targets are least reliable on exactly the
  // names that failed — which is where a view-driven strategy most needs them to be right.
  const rate = {};
  for (const tk of tickers) {
    const r = A.tickers[tk], t = r.tier;
    rate[t] ??= { n: 0, x: 0 };
    for (let i = 0; i < r.targets.dates.length; i++) {
      rate[t].n++;
      if ((r.targets.target[i] - r.targets.price[i]) / r.targets.price[i] > 2) rate[t].x++;
    }
  }
  const pct = t => (rate[t] ? (rate[t].x / rate[t].n * 100) : 0);
  console.log('  ℹ️  share of ticker-steps implying >200% upside, by tier: '
    + Object.keys(rate).sort().map(t => `${t} ${pct(t).toFixed(2)}%`).join(' · '));
  ok('extreme-upside rate is documented per tier', Object.keys(rate).length > 0);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
