/**
 * import-analyst-views.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds data/analyst-views.json — the POINT-IN-TIME archive of analyst 12-month
 * price targets that the backtester reads for its view-driven μ.
 *
 * This mirrors the BI-Rate pattern (bi-rate-seed.js + bi-rate.json + bi-rate.js):
 * a committed raw source of record, a generated archive, and a pure lookup module.
 * Union, never replace.
 *
 * ── Inputs ───────────────────────────────────────────────────────────────────
 *   data/analyst-views-raw/bloomberg-12m-targets*.csv  the TARGET SPINES (>= 1 required)
 *       Bloomberg exports in BLOCK layout — exactly what "Save As → CSV" gives
 *       for a sheet with one 4-column block per ticker:
 *
 *           <blank>,<blank>,BBCA,,,,,BBRI,,,,          ← row 1: ticker over each block
 *           ,,Date,12M Tgt Px,Price,Price Spread,,…    ← row 2: sub-headers
 *           ,,2026-08-26,8142.84,6425,1717.84,,…       ← row 3+: newest-first weekly rows
 *
 *       Column offsets are read from the header rows, NOT assumed — the real export
 *       has both 5- and 6-column strides. Dates may be ISO or anything Date.parse
 *       handles; they are normalized to ISO. Only Date / 12M Tgt Px / Price are used
 *       (the spread column is derived and ignored).
 *
 *       EVERY matching file is read, base file first and the rest alphabetically:
 *         bloomberg-12m-targets.csv        the 25 core names (CORE_TIER_JK)
 *         bloomberg-12m-targets-lq45.csv   LQ45 constituents the archive was missing
 *         bloomberg-12m-targets-broad.csv  wider IHSG names
 *       A ticker belongs to the FIRST file that carries it; a later file's block for
 *       the same name is skipped, not merged (the exports sit on different weekdays,
 *       so merging would interleave two cadences). Each ticker is tagged with the
 *       universe TIER it came from — see data/universe.js.
 *
 *   data/view-history/views-*.json                     ENRICHMENT (optional)
 *       The weekly capture archive. Bloomberg gives only the CONSENSUS MEAN target —
 *       no low/high and no analyst count — so the captures supply the dated
 *       dispersion + coverage that Black-Litterman's Ω needs. They do NOT contribute
 *       targets: keeping Bloomberg as the sole target spine avoids a mid-series
 *       source seam (captures land on Fridays, Bloomberg on Wednesdays).
 *
 *   data/dividends.json                                DATED DIVIDEND YIELD (optional)
 *       Built by scripts/fetch-dividends.mjs. Supplies the `y` in Q = upside + y as a
 *       DATED trailing-12-month yield instead of one present-day number. Before this
 *       existed, y came from the snapshot: a single current value applied to every
 *       step back to 2011, and present for only 13 of 86 names (the snapshot holds
 *       the core 25), so every other name silently used y = 0.
 *
 *   data/live-market-snapshot.json                     STATIC FALLBACK (optional)
 *       Analyst count and dispersion for names/dates no capture covers, plus a
 *       last-resort dividend yield for names dividends.json does not reach.
 *       Documented approximation — see the `notes` array in the output.
 *
 * ── Output ───────────────────────────────────────────────────────────────────
 *   data/analyst-views.json   read by data/analyst-views.js (pure as-of lookups)
 *
 * Usage:  node scripts/import-analyst-views.mjs [--csv <path>] [--out <path>]
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { UNIVERSE_TIERS, tierOf } from '../data/universe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

// ── args ──────────────────────────────────────────────────────────────────────
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const outPath = arg('--out', join(dataDir, 'analyst-views.json'));

// ── minimal RFC-4180 CSV parser ───────────────────────────────────────────────
// Hand-rolled rather than a dependency: the repo is dependency-light and this is
// the only CSV it reads. Handles quoted fields, embedded commas/newlines, "" escapes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Normalize a spreadsheet date cell to ISO yyyy-mm-dd, or null. */
function toISO(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function num(raw) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ── 1. parse the Bloomberg target spines ──────────────────────────────────────
// One or more block-layout exports. The base file is the 25-name research spine;
// the LQ45 / broad files widen the archive. PRECEDENCE IS BY FILE ORDER: the first
// file that carries a ticker owns its whole series, and a later file's block for
// that ticker is skipped rather than merged. The exports are dated one day apart
// (the base lands Wednesdays, the wider ones Thursdays), so merging would interleave
// two cadences into one series for the handful of names that appear twice.
const spineFiles = (() => {
  const override = arg('--csv', null);
  if (override) return [override];
  const dir = join(dataDir, 'analyst-views-raw');
  if (!existsSync(dir)) return [];
  const found = readdirSync(dir).filter(f => /^bloomberg-12m-targets.*\.csv$/i.test(f));
  // NARROWEST TIER FIRST — base (core), then one file per tier, then anything else
  // alphabetically. Not alphabetical order: the broad export carries a truncated
  // block for a few names the LQ45 export has in full (MAPI: 380 rows vs 782), and
  // whichever file comes first owns the series.
  const preferred = ['bloomberg-12m-targets.csv',
    ...UNIVERSE_TIERS.slice(1).map(t => `bloomberg-12m-targets-${t}.csv`)];
  const ordered = [
    ...preferred.filter(f => found.includes(f)),
    ...found.filter(f => !preferred.includes(f)).sort(),
  ];
  return ordered.map(f => join(dir, f));
})();

if (!spineFiles.length) {
  console.error(`❌  No target CSV found in ${join(dataDir, 'analyst-views-raw')}\n`
    + '    Export the Bloomberg sheet as CSV (block layout) named bloomberg-12m-targets*.csv and re-run.');
  process.exit(1);
}

/**
 * Locate the ticker blocks in one block-layout export.
 * Row 0 carries the ticker over the first column of each block; row 1 the sub-headers.
 * Each block is bounded by its own header offsets, so irregular strides are handled.
 */
function findBlocks(rows, label) {
  const tickerRow = rows[0];
  const subRow = rows[1];
  const out = [];
  for (let c = 0; c < tickerRow.length; c++) {
    const tk = String(tickerRow[c] ?? '').trim().toUpperCase();
    if (!tk) continue;
    // Bound by the SUB-HEADER row too: trailing empty cells are commonly trimmed, so the
    // ticker row can be shorter than the sub-header row and the LAST block would otherwise
    // scan a single column and lose its Target header.
    const wide = Math.max(tickerRow.length, subRow.length);
    let end = wide;
    for (let k = c + 1; k < wide; k++) {
      if (String(tickerRow[k] ?? '').trim()) { end = k; break; }
    }
    const find = (re) => {
      for (let k = c; k < end; k++) if (re.test(String(subRow[k] ?? '').trim())) return k;
      return -1;
    };
    const dCol = find(/^date$/i);
    const tCol = find(/tgt|target/i);
    const pCol = find(/^price$/i);
    if (dCol < 0 || tCol < 0) {
      console.warn(`⚠️   ${label}: ${tk} has no Date/Target columns — block skipped.`);
      continue;
    }
    out.push({ ticker: tk, dCol, tCol, pCol });
  }
  return out;
}

const spine = new Map();        // ticker -> Map<iso, {target, price}>
const origin = new Map();       // ticker -> source file that owns the series
const spineSources = [];        // per-file report for the output's `sources` block

for (const path of spineFiles) {
  const label = path.split('/').slice(-1)[0];
  if (!existsSync(path)) { console.error(`❌  Missing target CSV: ${path}`); process.exit(1); }
  const rows = parseCsv(readFileSync(path, 'utf8'));
  if (rows.length < 3) {
    console.error(`❌  ${label}: no data rows (expected ticker row, sub-header row, then data).`);
    process.exit(1);
  }
  const blocks = findBlocks(rows, label);
  if (!blocks.length) {
    console.error(`❌  ${label}: no ticker blocks found. Is row 1 the ticker header row?`);
    process.exit(1);
  }
  const claimed = [], skipped = [];
  for (const b of blocks) {
    const owner = origin.get(b.ticker);
    if (owner && owner !== label) { skipped.push(b.ticker); continue; }   // earlier file wins
    const m = spine.get(b.ticker) ?? new Map();
    for (let r = 2; r < rows.length; r++) {
      const iso = toISO(rows[r][b.dCol]);
      const target = num(rows[r][b.tCol]);
      const price = b.pCol >= 0 ? num(rows[r][b.pCol]) : null;
      if (!iso || target == null || target <= 0) continue;
      if (price == null || price <= 0) continue; // upside needs a contemporaneous price
      m.set(iso, { target, price });            // later block wins on a repeated date
    }
    spine.set(b.ticker, m);
    origin.set(b.ticker, label);
    claimed.push(b.ticker);
  }
  spineSources.push({ file: `analyst-views-raw/${label}`, blocks: blocks.length, tickers: claimed.length, skippedDuplicates: skipped });
  console.log(`  · ${label}: ${claimed.length} ticker(s)`
    + (skipped.length ? `, ${skipped.length} already owned by an earlier file (${skipped.join(', ')})` : ''));
}

if (!spine.size) {
  console.error('❌  No ticker blocks found in any spine file.');
  process.exit(1);
}


// ── 1b. per-ticker supplements ────────────────────────────────────────────────
// analyst-views-raw/per-ticker/<TICKER>.csv — a simple one-ticker table with the same
// column names as a block ("Date", "12M Tgt Px", "Price"). Exists because a vendor export
// can silently come back TRUNCATED for one name: the BBNI block arrived with 105 weeks
// against 783 for its peers, which would have quietly left a major bank on the sample-mean
// fallback for 80% of the walk. Supplements WIN on a shared date — they are the deliberate
// correction — and a new file needs no code change, just a re-run.
const perTickerDir = join(dataDir, 'analyst-views-raw', 'per-ticker');
const supplements = [];
if (existsSync(perTickerDir)) {
  for (const f of readdirSync(perTickerDir).filter(f => /\.csv$/i.test(f))) {
    const ticker = f.replace(/\.csv$/i, '').toUpperCase();
    const rows2 = parseCsv(readFileSync(join(perTickerDir, f), 'utf8'));
    if (rows2.length < 2) { console.warn(`⚠️   ${f}: no data rows — skipped.`); continue; }
    const hdr = rows2[0].map(h => String(h ?? '').trim());
    const dCol = hdr.findIndex(h => /^date$/i.test(h));
    const tCol = hdr.findIndex(h => /tgt|target/i.test(h));
    const pCol = hdr.findIndex(h => /^price$/i.test(h));
    if (dCol < 0 || tCol < 0 || pCol < 0) {
      console.warn(`⚠️   ${f}: needs Date / 12M Tgt Px / Price columns — skipped.`);
      continue;
    }
    const m = spine.get(ticker) ?? new Map();
    const before = m.size;
    let added = 0;
    for (let r = 1; r < rows2.length; r++) {
      const iso = toISO(rows2[r][dCol]);
      const target = num(rows2[r][tCol]);
      const price = num(rows2[r][pCol]);
      if (!iso || !(target > 0) || !(price > 0)) continue;
      if (!m.has(iso)) added++;
      m.set(iso, { target, price });          // supplement wins on a shared date
    }
    spine.set(ticker, m);
    supplements.push({ ticker, file: `per-ticker/${f}`, rows: m.size - before + added, total: m.size, wasEmpty: before === 0 });
    console.log(`  + ${ticker}: ${before} → ${m.size} dated targets (supplement ${f})`);
  }
}

// ── 2. capture archive → dated Ω enrichment (dispersion + analyst coverage) ────
const viewDir = join(dataDir, 'view-history');
const enrich = new Map(); // ticker -> [{ d, analysts, dispersion }]
let captureFiles = 0;
if (existsSync(viewDir)) {
  const files = readdirSync(viewDir).filter(f => /^views-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  captureFiles = files.length;
  for (const f of files) {
    let cap;
    try { cap = JSON.parse(readFileSync(join(viewDir, f), 'utf8')); }
    catch { console.warn(`⚠️   ${f}: unreadable — skipped.`); continue; }
    const asOf = toISO(cap.asOf) ?? toISO(f.slice(6, 16));
    if (!asOf) continue;
    for (const a of cap.assets ?? []) {
      const fe = a.forwardEstimates ?? {};
      const mean = fe.meanTarget;
      if (!mean || mean <= 0) continue;
      const lo = Math.min(fe.lowTarget ?? mean, mean, fe.highTarget ?? mean);
      const hi = Math.max(fe.lowTarget ?? mean, mean, fe.highTarget ?? mean);
      const list = enrich.get(a.ticker) ?? [];
      list.push({
        d: asOf,
        analysts: fe.totalAnalysts ?? null,
        dispersion: round(Math.max(0, (hi - lo) / mean), 4),
      });
      enrich.set(a.ticker, list);
    }
  }
}

// ── 2b. dividend record → dated yield series ──────────────────────────────────
// Embedded into the archive (rather than read alongside it) so analyst-views.js stays
// a pure function of ONE archive and the backtester needs no extra wiring.
const divPath = join(dataDir, 'dividends.json');
const divSeries = new Map();   // ticker -> [{ d, y }] ASCENDING
let divMeta = null;
if (existsSync(divPath)) {
  try {
    const dv = JSON.parse(readFileSync(divPath, 'utf8'));
    divMeta = { file: 'dividends.json', generated: dv.generated, windowDays: dv.windowDays ?? 365 };
    for (const [tk, rec] of Object.entries(dv.tickers ?? {})) {
      const ev = (rec.events ?? [])
        .filter(e => e?.d && e.y > 0)
        .map(e => ({ d: e.d, y: e.y }))
        .sort((a, b) => a.d.localeCompare(b.d));
      divSeries.set(tk, ev);     // an EMPTY array is meaningful: covered, pays nothing
    }
  } catch (e) {
    console.warn(`⚠️   Unreadable ${divPath}: ${e.message} — falling back to the static yield.`);
  }
} else {
  console.warn(`⚠️   No dividends.json — Q will use the STATIC snapshot yield.`
    + '\n     Build it with: node scripts/fetch-dividends.mjs');
}

// ── 3. snapshot → static per-ticker fallbacks ─────────────────────────────────
const snapPath = join(dataDir, 'live-market-snapshot.json');
const statics = new Map(); // ticker -> { dividendYield, totalAnalysts, dispersion }
if (existsSync(snapPath)) {
  let snap;
  try { snap = JSON.parse(readFileSync(snapPath, 'utf8')); } catch { snap = null; }
  for (const a of snap?.assets ?? []) {
    const fe = a.forwardEstimates ?? {};
    const mean = fe.meanTarget;
    const lo = mean ? Math.min(fe.lowTarget ?? mean, mean, fe.highTarget ?? mean) : null;
    const hi = mean ? Math.max(fe.lowTarget ?? mean, mean, fe.highTarget ?? mean) : null;
    statics.set(a.ticker, {
      dividendYield: round(a.meta?.dividendYield ?? 0, 5),
      totalAnalysts: fe.totalAnalysts ?? null,
      dispersion: mean ? round(Math.max(0, (hi - lo) / mean), 4) : null,
    });
  }
}

function round(v, dp) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

// ── 4. assemble ───────────────────────────────────────────────────────────────
const tickersOut = {};
const perTicker = {};
let totalRows = 0;
let globalStart = null, globalEnd = null;

for (const [ticker, m] of [...spine.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const dates = [...m.keys()].sort();                       // ASCENDING — lookups binary-search
  if (!dates.length) continue;
  const target = dates.map(d => round(m.get(d).target, 2));
  const price = dates.map(d => round(m.get(d).price, 2));

  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
  const eList = (enrich.get(ticker) ?? []).sort((a, b) => a.d.localeCompare(b.d));
  const st = statics.get(ticker) ?? {};
  // Prefer the newest capture for the static fallback; fall back to the snapshot.
  const newestCap = eList.length ? eList[eList.length - 1] : null;

  const dv = divSeries.get(ticker) ?? null;
  tickersOut[ticker] = {
    tier: tierOf(ticker) ?? 'untagged',        // 'core' | 'lq45' | 'broad'
    source: origin.get(ticker) ?? null,
    ...(dv?.length ? { div: dv } : {}),        // DATED yield; absent ⇒ static fallback
    static: {
      dividendYield: st.dividendYield ?? 0,
      totalAnalysts: newestCap?.analysts ?? st.totalAnalysts ?? null,
      dispersion: newestCap?.dispersion ?? st.dispersion ?? null,
    },
    targets: { dates, target, price },
    ...(eList.length ? { enrich: eList } : {}),
  };

  perTicker[ticker] = {
    tier: tierOf(ticker) ?? 'untagged',
    divEvents: dv?.length ?? 0,
    start: dates[0], end: dates[dates.length - 1], rows: dates.length,
    maxGapDays: gaps.length ? Math.max(...gaps) : 0,
    enrichRows: eList.length,
  };
  totalRows += dates.length;
  if (!globalStart || dates[0] < globalStart) globalStart = dates[0];
  if (!globalEnd || dates[dates.length - 1] > globalEnd) globalEnd = dates[dates.length - 1];
}

// Per-tier roll-up — 'untagged' is a ticker present in a spine but absent from
// data/universe.js, which means the tier lists there need updating.
const byTier = {};
for (const [tk, s2] of Object.entries(perTicker)) {
  const t = s2.tier;
  const b = byTier[t] ?? (byTier[t] = { tickers: 0, rows: 0, names: [] });
  b.tickers++; b.rows += s2.rows; b.names.push(tk);
}
const untagged = byTier.untagged?.names ?? [];
if (untagged.length) {
  console.warn(`⚠️   ${untagged.length} ticker(s) not in any universe tier — add them to `
    + `data/universe.js: ${untagged.join(', ')}`);
}

const out = {
  generated: new Date().toISOString(),
  description:
    'Point-in-time analyst 12-month price targets per ticker. Targets are the Bloomberg '
    + 'consensus mean ("12M Tgt Px") paired with the contemporaneous Bloomberg price, so the '
    + 'implied upside is source-consistent and independent of the Yahoo price series the '
    + 'backtest trades on. Dates are AS-OF: a lookup at time t must take the newest row '
    + 'with date <= t. Every ticker carries the universe `tier` it entered through '
    + "('core' = CORE_TIER_JK, the original 25 research names, 'lq45' = LQ45 names the archive was missing, 'broad' = wider "
    + 'IHSG names) — see data/universe.js. Read via data/analyst-views.js — do not hand-edit.',
  horizonMonths: 12,
  coverage: {
    start: globalStart, end: globalEnd,
    tickers: Object.keys(tickersOut).length, rows: totalRows,
    byTier, perTicker,
  },
  sources: {
    bloomberg: {
      files: spineSources, field: '12M Tgt Px', role: 'target spines', rows: totalRows,
      precedence: 'a ticker belongs to the FIRST file listed that carries it; later blocks for the same name are skipped, not merged',
    },
    capture: { dir: 'view-history/', files: captureFiles, role: 'dated dispersion + analyst coverage (Omega); contributes no targets' },
    ...(divMeta ? { dividends: { ...divMeta, role: 'DATED trailing-12-month yield — the y in Q = upside + y', tickers: [...divSeries.keys()].length } } : {}),
    snapshot: { file: 'live-market-snapshot.json', role: 'static per-ticker dividend yield / dispersion / analyst-count fallback' },
    ...(supplements.length ? { supplements: { dir: 'analyst-views-raw/per-ticker/', role: 'per-ticker corrections for truncated vendor blocks; win on a shared date', entries: supplements } } : {}),
  },
  notes: [
    'Dividend yield in Q = (target - price)/price + y is DATED: a trailing-12-month sum of '
    + 'per-ex-date yield fractions from dividends.json, look-ahead-free (an ex-date counts only '
    + 'once it has passed). Each dividend is measured against the price prevailing when it was '
    + 'paid, so y is the yield actually earned rather than old payments rescaled by a newer price.',
    'APPROXIMATION — names the dividend record does not reach still fall back to the STATIC '
    + 'snapshot yield (one present-day number at every historical step), and to 0 when the '
    + 'snapshot lacks them too. viewAsOf reports which was used via `dividendSource`.',
    'APPROXIMATION — analyst count and target dispersion are static before the first weekly capture '
    + '(2026-06-19). They drive Black-Litterman Omega only; the target spine itself is fully dated.',
    'Bloomberg rows are Wednesdays; the backtest rebalances on the weekly (Friday) bar, so the as-of '
    + 'lookup picks up a view 2 days old at most on a fresh week. No look-ahead.',
    'The archive is WIDER than the optimizer/forward-test universe. tier=core is the original 25 '
    + 'research names (CORE_TIER_JK); tier=lq45 and tier=broad exist so a backtest or sweep can opt into a '
    + 'larger opportunity set. Adding a name here does NOT add it to any fetch script.',
    'Coverage is NOT uniform — see coverage.perTicker. Names with late starts or long gaps fall back '
    + 'to the trailing sample mean at steps the archive cannot cover (see analyst-views.js staleness).',
  ],
  tickers: tickersOut,
};

writeFileSync(outPath, JSON.stringify(out) + '\n');

// ── 5. report ─────────────────────────────────────────────────────────────────
const kb = (readFileSync(outPath).length / 1024).toFixed(0);
console.log(`\n✅  ${outPath}  (${kb} KB)`);
console.log(`    ${out.coverage.tickers} tickers · ${totalRows.toLocaleString('en-US')} dated targets · ${globalStart} → ${globalEnd}`);
console.log(`    enrichment: ${captureFiles} weekly capture(s)`);
console.log('    tiers: ' + [...UNIVERSE_TIERS, 'untagged']
  .filter(t => byTier[t])
  .map(t => `${t} ${byTier[t].tickers}`).join(' · ') + '\n');

const avgRows = totalRows / out.coverage.tickers;
console.log(`    ${'ticker'.padEnd(7)}${'tier'.padEnd(7)}${'rows'.padStart(6)}${'start'.padStart(13)}${'end'.padStart(13)}${'maxGap'.padStart(8)}`);
for (const tier of [...UNIVERSE_TIERS, 'untagged']) {
  const names = byTier[tier]?.names ?? [];
  if (!names.length) continue;
  console.log(`    ── ${tier} (${names.length}) ${'─'.repeat(Math.max(0, 40 - tier.length))}`);
  for (const tk of names) {
    const st = perTicker[tk];
    const flag = st.maxGapDays > 90 ? '  ⚠ gap' : (st.rows < avgRows * 0.5 ? '  ⚠ short' : '');
    console.log(`    ${tk.padEnd(7)}${tier.padEnd(7)}${String(st.rows).padStart(6)}${st.start.padStart(13)}${st.end.padStart(13)}${String(st.maxGapDays).padStart(8)}${flag}`);
  }
}
