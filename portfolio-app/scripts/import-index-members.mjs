/**
 * import-index-members.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds data/index-members.json — the POINT-IN-TIME record of LQ45 constituents,
 * their index weights and their shares outstanding, monthly from 2011.
 *
 * Same contract as the other archives (bi-rate, analyst-views, dividends): a committed
 * raw source, a generated archive, and a pure lookup module (data/index-members.js).
 *
 * ── Input ────────────────────────────────────────────────────────────────────
 *   data/index-members-raw/lq45-monthly.csv
 *       Flattened from the per-month Bloomberg exports ("LQ45 as of Mmm 01 YYYY.xlsx",
 *       columns Ticker / Name / Weight / Shares / Price). One row per (date, ticker):
 *
 *           date,ticker,weight,sharesOutMn,price
 *           2011-01-01,ASII,10.417055,4048.355314,
 *
 *       Dates are the 1st of each calendar month. LQ45 reviews take effect on the first
 *       TRADING day of Feb/May/Aug/Nov, so a review lands in the FOLLOWING month's row —
 *       up to ~4 weeks of lag. That is deliberate: staleness withholds information, it
 *       never leaks it, so the as-of lookup stays look-ahead-free.
 *
 * ── Why it matters ───────────────────────────────────────────────────────────
 * Two long-standing approximations die here. Membership stops being "today's list applied
 * to all of history" (worth 0.68 of Sharpe on this repo's LQ45 tier), and `shares` becomes
 * DATED — the backtest engine otherwise builds historical market cap from one present-day
 * share count, which no issuance or buyback since is reflected in.
 *
 * Usage:  node scripts/import-index-members.mjs [--csv <path>] [--out <path>]
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const csvPath = arg('--csv', join(dataDir, 'index-members-raw', 'lq45-monthly.csv'));
const outPath = arg('--out', join(dataDir, 'index-members.json'));

if (!existsSync(csvPath)) {
  console.error(`❌  Missing ${csvPath}`);
  process.exit(1);
}

const num = v => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

// ── parse ─────────────────────────────────────────────────────────────────────
const lines = readFileSync(csvPath, 'utf8').split('\n').filter(l => l.trim());
const header = lines[0].split(',').map(h => h.trim());
const col = name => header.indexOf(name);
const iDate = col('date'), iTk = col('ticker'), iW = col('weight'),
      iSh = col('sharesOutMn'), iPx = col('price');
if (iDate < 0 || iTk < 0 || iW < 0) {
  console.error('❌  CSV needs at least date, ticker and weight columns.');
  process.exit(1);
}

const byDate = new Map();
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split(',');
  const date = (f[iDate] ?? '').trim();
  // Bloomberg quotes IDX names as "ASII IJ Equity"; keep only the bare symbol so the
  // whole monorepo speaks one ticker namespace (see CLAUDE.md § Conventions).
  const ticker = (f[iTk] ?? '').trim().split(/\s+/)[0].toUpperCase().replace(/\.JK$/i, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !ticker) continue;
  const row = {
    ticker,
    weight: round(num(f[iW]), 6),
    shares: round(num(f[iSh]), 4),
    price: round(num(f[iPx]), 4),
  };
  if (!(row.weight > 0)) continue;
  const list = byDate.get(date) ?? [];
  list.push(row);
  byDate.set(date, list);
}

const dates = [...byDate.keys()].sort();                     // ASCENDING — lookups binary-search
const snapshots = dates.map(d => ({
  date: d,
  members: byDate.get(d).sort((a, b) => b.weight - a.weight), // heaviest first, as exported
}));

// ── integrity ─────────────────────────────────────────────────────────────────
// A snapshot whose weights do not sum to ~100 is a truncated or double-counted export, and
// would silently distort any prior built from it. Warn loudly rather than writing it blind.
const warnings = [];
for (const s of snapshots) {
  const sum = s.members.reduce((a, m) => a + m.weight, 0);
  if (Math.abs(sum - 100) > 1) warnings.push(`${s.date}: weights sum to ${sum.toFixed(2)}, not ~100`);
  if (s.members.length !== 45) warnings.push(`${s.date}: ${s.members.length} members, expected 45`);
}
const dupes = snapshots.filter(s => new Set(s.members.map(m => m.ticker)).size !== s.members.length);
for (const s of dupes) warnings.push(`${s.date}: duplicate ticker in snapshot`);

const universe = [...new Set(snapshots.flatMap(s => s.members.map(m => m.ticker)))].sort();
const withShares = snapshots.filter(s => s.members.every(m => m.shares > 0)).length;
const withPrice = snapshots.filter(s => s.members.some(m => m.price > 0)).length;

const out = {
  generated: new Date().toISOString(),
  index: 'LQ45',
  description:
    'Point-in-time LQ45 constituents with index weight and shares outstanding, monthly '
    + '(1st of each calendar month). Dates are AS-OF: a lookup at time t must take the newest '
    + 'snapshot dated <= t. Reviews take effect on the first TRADING day of Feb/May/Aug/Nov, so '
    + 'a review appears in the FOLLOWING month\'s snapshot — a lag of up to ~4 weeks, which is '
    + 'safe (staleness withholds information rather than leaking it). `weight` is percent and '
    + 'sums to 100 per snapshot; `shares` is millions; `price` is the unadjusted traded price '
    + 'and is present in only some snapshots. Read via data/index-members.js — do not hand-edit.',
  source: 'Bloomberg per-month LQ45 member exports (Ticker / Name / Weight / Shares / Price)',
  coverage: {
    start: dates[0], end: dates[dates.length - 1],
    snapshots: snapshots.length,
    universe: universe.length,
    snapshotsWithFullShares: withShares,
    snapshotsWithAnyPrice: withPrice,
  },
  notes: [
    'Membership is monthly but LQ45 reviews are quarterly (effective the first trading day of '
    + 'Feb/May/Aug/Nov); intervening months simply repeat the standing list.',
    '`price` is populated in roughly half the source files. Never depend on it — the backtest '
    + 'takes prices from its own history file, which is split- and dividend-adjusted.',
    'USE `weight`, NOT `shares`, as the cap-prior input. `weight` is internally consistent '
    + '(sums to 100 per snapshot) and is already the free-float-adjusted number the index uses. '
    + '`shares` appears to be INDEX shares and carries a methodology break where IDX adopted '
    + 'free-float weighting mid-sample: TLKM reads 100.8bn in 2016 and 40.0bn in 2026, and '
    + 'BBRI rises 162% across its 2017 split. Reconstructing market cap from it would be wrong '
    + 'in a way that is easy to miss. It is kept for provenance and cross-checking only.',
  ],
  dates,
  universe,
  snapshots,
};

writeFileSync(outPath, JSON.stringify(out) + '\n');

const kb = (readFileSync(outPath).length / 1024).toFixed(0);
console.log(`✅  ${outPath}  (${kb} KB)`);
console.log(`    ${snapshots.length} monthly snapshots · ${dates[0]} → ${dates[dates.length - 1]}`);
console.log(`    ${universe.length} distinct tickers were EVER constituents`);
console.log(`    shares complete in ${withShares}/${snapshots.length} snapshots · price present in ${withPrice}`);
if (warnings.length) {
  console.log(`\n⚠️   ${warnings.length} integrity warning(s):`);
  for (const w of warnings.slice(0, 20)) console.log(`      ${w}`);
} else {
  console.log('    integrity: every snapshot has 45 members and weights summing to ~100 ✓');
}
