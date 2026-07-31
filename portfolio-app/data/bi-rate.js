/**
 * bi-rate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The definitive Bank Indonesia policy-rate (BI-Rate) source — the SINGLE SOURCE
 * OF TRUTH for r_f, imported by every app that needs a risk-free rate:
 *   • portfolio-app/data/fetch-snapshot.js            (optimizer snapshot)
 *   • portfolio-app/data/refresh-bi-rate.js           (daily archive updater)
 *   • backtest-portfolio/scripts/fetch-backtest-history.mjs  (walk-forward history)
 *   • backtest-portfolio/src/backtestEngine.js        (dated per-rebalance r_f)
 *
 * Before this module there were five independent copies of the literal 0.0575
 * scattered across the monorepo and only the optimizer ever talked to BI. Edit the
 * scrape or the fallback here and every consumer follows.
 *
 * PURE MODULE — no `fs`, no `process`, no DOM. `backtestEngine.js` imports the lookup
 * helpers and runs in the browser via backtestWorker.js, so this file must stay
 * bundler-safe. `fetch` is used only inside the network functions and is global in both
 * Node 20 and browsers. File I/O lives in the callers, which already do it.
 *
 * ── THE ARCHIVE ─────────────────────────────────────────────────────────────
 * `bi-rate.json` is the one file that holds the policy-rate history, and every app
 * resolves r_f from it:
 *
 *   bi-rate-seed.js  (compiled history, 2011 → ~present)  ─┐
 *   bi-rate.json     (rows captured by earlier runs)      ─┼─► buildArchive() ─► bi-rate.json
 *   bi.go.id scrape  (whatever BI still renders)          ─┘
 *
 * Union, never replace: BI publishes only a rolling window, so a scrape that drops old
 * rows must not shorten the archive. On a shared effective date the higher-ranked
 * source wins (SOURCE_RANK), which is what lets a live scrape correct a compiled row.
 *
 * Consumers split by what they need:
 *   • optimizer → `current` only (today's rate)
 *   • backtest  → the whole `history` (each step scored at the rate in effect then)
 *   • tracker   → `current` + `history`, so a forward-test row is scored at the rate
 *                 in effect on its own date
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { BI_RATE_SEED, INSTRUMENT_SWITCH_DATE, INSTRUMENT_LEGACY, INSTRUMENT_BI7DRR } from './bi-rate-seed.js';

export { INSTRUMENT_SWITCH_DATE, INSTRUMENT_LEGACY, INSTRUMENT_BI7DRR };
export { BI_RATE_SEED, SEED_REVIEW_FROM, SEED_PROVENANCE } from './bi-rate-seed.js';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Provenance of an archive row, lowest → highest precedence. A scrape straight from
 * Bank Indonesia outranks a row compiled from public record, so the archive corrects
 * itself the first time BI's table covers a date the seed also covers.
 */
export const SOURCE_COMPILED = 'compiled'; // bi-rate-seed.js
export const SOURCE_IMPORTED = 'imported'; // operator-supplied file
export const SOURCE_SCRAPED  = 'bi.go.id'; // live from Bank Indonesia

const SOURCE_RANK = { [SOURCE_COMPILED]: 0, [SOURCE_IMPORTED]: 1, [SOURCE_SCRAPED]: 2 };
const rankOf = (src) => SOURCE_RANK[src] ?? 0;

/** Official Bank Indonesia BI-Rate table (English page; most-recent decision first). */
export const BI_RATE_URL = 'https://www.bi.go.id/en/statistik/indikator/bi-rate.aspx';

/**
 * Last-resort BI-Rate (decimal). Only reached when BOTH the live scrape and the
 * committed bi-rate.json cache are unavailable — see resolveBIRate() in the callers.
 */
export const BI_RATE_FALLBACK = 0.0575; // 5.75% as of 18 June 2026

/** Sanity band for a parsed rate; anything outside is treated as a parse failure. */
export const BI_RATE_MIN = 0.01;
export const BI_RATE_MAX = 0.15;

// ── Date helpers (UTC-safe; BI publishes calendar dates, not timestamps) ──────

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * '18 June 2026' → '2026-06-18'. Accepts full names and 3-letter abbreviations
 * (BI's table has used both). Returns null when the month is unrecognisable.
 */
export function parseBIDate(text) {
  const m = String(text).trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
}

/** Whole days between two ISO dates (b − a). Negative when b precedes a. */
function daysBetween(aISO, bISO) {
  return Math.round((Date.parse(`${bISO}T00:00:00Z`) - Date.parse(`${aISO}T00:00:00Z`)) / 86400000);
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse every row of BI's policy-rate table, not just the latest decision.
 *
 * The EN page renders the history as a most-recent-first table:
 *   <td>18 June 2026</td><td>5.75 %</td>
 *   <td>21 May 2026</td><td>6.00 %</td>
 *   …
 * We take all date+rate pairs, drop anything outside the sanity band, dedupe by
 * effective date (keeping the first/newest occurrence), and return newest-first.
 *
 * @param {string} html  raw page HTML
 * @returns {{effective: string, rate: number}[]}  newest-first; [] when nothing parses
 */
export function parseBIRateTable(html) {
  const tbody = html.indexOf('<tbody');
  const body = tbody >= 0 ? html.slice(tbody) : html;

  const re = /(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*<\/td>\s*<td[^>]*>\s*(\d+(?:\.\d+)?)\s*%/g;
  const seen = new Set();
  const rows = [];

  for (const m of body.matchAll(re)) {
    const effective = parseBIDate(m[1]);
    if (!effective || seen.has(effective)) continue;
    const rate = +(parseFloat(m[2]) / 100).toFixed(6);
    if (!Number.isFinite(rate) || rate < BI_RATE_MIN || rate > BI_RATE_MAX) continue;
    seen.add(effective);
    rows.push({ effective, rate, instrument: instrumentFor(effective), source: SOURCE_SCRAPED });
  }

  // The page is authored newest-first, but don't rely on it.
  rows.sort((a, b) => (a.effective < b.effective ? 1 : a.effective > b.effective ? -1 : 0));
  return rows;
}

// ── Archive assembly ─────────────────────────────────────────────────────────

/**
 * Which policy instrument was in force on a date. The 19 Aug 2016 switch from the legacy
 * BI Rate to the BI 7-Day Reverse Repo Rate put a ~125 bp step in the spliced series that
 * is an instrument change, not an easing decision — see bi-rate-seed.js.
 */
export function instrumentFor(isoDate) {
  return isoDate < INSTRUMENT_SWITCH_DATE ? INSTRUMENT_LEGACY : INSTRUMENT_BI7DRR;
}

/** Drop malformed rows and fill in the tags older archives were written without. */
function normalizeRow(row) {
  if (!row || typeof row.effective !== 'string' || !Number.isFinite(row.rate)) return null;
  return {
    effective: row.effective,
    rate: row.rate,
    instrument: row.instrument ?? instrumentFor(row.effective),
    source: row.source ?? SOURCE_COMPILED,
  };
}

/**
 * Union any number of decision lists into one archive, newest-first.
 *
 * UNION, NEVER REPLACE — BI renders only a rolling window of decisions, so a scrape that
 * no longer shows 2019 must not delete 2019 from the archive. On a shared effective date
 * the higher-ranked source wins; ties keep the later argument, so callers pass lists in
 * increasing order of trust.
 *
 * @param {...({effective: string, rate: number, instrument?: string, source?: string}[]|null|undefined)} lists
 * @returns {{effective: string, rate: number, instrument: string, source: string}[]} newest-first
 */
export function mergeHistory(...lists) {
  const byDate = new Map();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const row = normalizeRow(raw);
      if (!row) continue;
      const prior = byDate.get(row.effective);
      if (prior && rankOf(prior.source) > rankOf(row.source)) continue;
      byDate.set(row.effective, row);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.effective < b.effective ? 1 : a.effective > b.effective ? -1 : 0));
}

/**
 * Assemble the archive from every input, in increasing order of trust:
 * compiled seed → rows already cached → whatever BI is serving now.
 *
 * @returns {{effective: string, rate: number, instrument: string, source: string}[]} newest-first
 */
export function buildArchive({ cached = null, scraped = null, imported = null } = {}) {
  return mergeHistory(BI_RATE_SEED.map(r => ({ ...r, source: SOURCE_COMPILED })), cached, imported, scraped);
}

/**
 * Describe what an archive actually covers — the numbers a caller needs to decide whether
 * to trust a dated r_f, and what the refresh job prints to its run summary.
 *
 * `maxGapDays` is the load-bearing one: rateAsOf() holds a rate flat across a gap, so a
 * long gap silently scores months of backtest steps at a stale rate. BI meets ~8x/year,
 * so anything past ~120 days means decisions are missing rather than simply unchanged.
 *
 * @returns {{count: number, first: string|null, last: string|null, current: number|null,
 *            bySource: Record<string, number>, maxGapDays: number, maxGapFrom: string|null,
 *            maxGapTo: string|null}}
 */
export function archiveCoverage(history) {
  const asc = ascending(history);
  const bySource = {};
  for (const r of asc) bySource[r.source ?? SOURCE_COMPILED] = (bySource[r.source ?? SOURCE_COMPILED] ?? 0) + 1;

  let maxGapDays = 0, maxGapFrom = null, maxGapTo = null;
  for (let i = 1; i < asc.length; i++) {
    const gap = daysBetween(asc[i - 1].effective, asc[i].effective);
    if (gap > maxGapDays) { maxGapDays = gap; maxGapFrom = asc[i - 1].effective; maxGapTo = asc[i].effective; }
  }

  return {
    count: asc.length,
    first: asc.length ? asc[0].effective : null,
    last: asc.length ? asc[asc.length - 1].effective : null,
    current: asc.length ? asc[asc.length - 1].rate : null,
    bySource,
    maxGapDays,
    maxGapFrom,
    maxGapTo,
  };
}

// ── Pure lookups (used by the backtest engine, in-browser) ───────────────────

/** Ascending-by-date copy; tolerates unsorted or malformed input. */
function ascending(history) {
  return (history ?? [])
    .filter(r => r && typeof r.effective === 'string' && Number.isFinite(r.rate))
    .slice()
    .sort((a, b) => (a.effective < b.effective ? -1 : a.effective > b.effective ? 1 : 0));
}

/**
 * The BI-Rate in effect ON `isoDate` — i.e. the most recent decision whose effective
 * date is <= isoDate. NEVER returns a rate that takes effect later.
 *
 * This is the look-ahead guard for the walk-forward backtest: at a 2013 rebalance the
 * optimizer must see the 2013 policy rate, not today's. Getting this wrong silently
 * leaks future information into every historical step.
 *
 * Dates before the series begins fall back to the OLDEST known rate (a flat
 * back-extension). Callers that care should compare isoDate against the first entry
 * and warn — see the coverage warning in backtestEngine.
 *
 * @param {{effective: string, rate: number}[]} history
 * @param {string} isoDate  'YYYY-MM-DD'
 * @returns {number|null}  null only when history is empty
 */
export function rateAsOf(history, isoDate) {
  const asc = ascending(history);
  if (!asc.length) return null;

  let lo = 0, hi = asc.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (asc[mid].effective <= isoDate) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  // idx < 0 ⇒ isoDate precedes the whole series ⇒ flat back-extension.
  return idx >= 0 ? asc[idx].rate : asc[0].rate;
}

/**
 * Time-weighted mean BI-Rate across [startISO, endISO], weighting each rate by the
 * number of days it was actually in effect inside the window.
 *
 * DISPLAY ONLY. Sharpe consumes the dated series per period (see sharpeFromExcess in
 * ../src/math/performance.js); this is the single summary number shown in the
 * backtest's r_f stat and the results window metadata.
 *
 * @returns {number|null}
 */
export function meanRateOver(history, startISO, endISO) {
  const asc = ascending(history);
  if (!asc.length) return null;
  const span = daysBetween(startISO, endISO);
  if (span <= 0) return rateAsOf(asc, startISO);

  // Segment boundaries: window start, every decision strictly inside it, window end.
  const bounds = [startISO, ...asc.filter(r => r.effective > startISO && r.effective < endISO).map(r => r.effective), endISO];

  let weighted = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    const days = daysBetween(bounds[i], bounds[i + 1]);
    if (days <= 0) continue;
    weighted += rateAsOf(asc, bounds[i]) * days;
  }
  return +(weighted / span).toFixed(6);
}

/**
 * Build a dated r_f lookup with a constant fallback.
 *
 * When `history` is absent or empty the returned function ignores its argument and
 * always yields `constant` — exactly the pre-series behaviour, so results computed
 * without a series reproduce byte-for-byte.
 *
 * @param {{effective: string, rate: number}[]|null|undefined} history
 * @param {number} constant
 * @returns {((isoDate: string) => number) & { mode: 'series'|'constant', history: object[] }}
 */
export function makeRateLookup(history, constant = BI_RATE_FALLBACK) {
  const asc = ascending(history);
  const fn = asc.length ? (isoDate) => rateAsOf(asc, isoDate) : () => constant;
  fn.mode = asc.length ? 'series' : 'constant';
  fn.history = asc;
  return fn;
}

/**
 * Convert an ANNUAL rate to the equivalent rate over one period of a `ppy`-per-year
 * series: (1 + annual)^(1/ppy) − 1. Geometric de-annualization, so compounding the
 * result ppy times reproduces the annual rate exactly.
 *
 * Used to build the per-period excess-return series behind Sharpe.
 */
export function perPeriodRate(annualRate, periodsPerYear) {
  if (!Number.isFinite(annualRate) || !(periodsPerYear > 0)) return 0;
  return Math.pow(1 + annualRate, 1 / periodsPerYear) - 1;
}

// ── Network ──────────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  // BI's SharePoint backend stalls on non-browser requests — send real browser headers.
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Scrape the FULL BI-Rate decision history. Throws on any network/parse failure —
 * callers decide whether to fall back to the cache or the literal.
 *
 * @returns {Promise<{current: number, effective: string, history: {effective: string, rate: number}[]}>}
 */
export async function fetchBIRateSeries() {
  const res = await fetch(BI_RATE_URL, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(40000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const history = parseBIRateTable(await res.text());
  if (!history.length) throw new Error('no rate rows found in table');

  return { current: history[0].rate, effective: history[0].effective, history };
}

/**
 * Latest BI-Rate as a bare decimal, never throwing — the shape fetch-snapshot.js used
 * before this module existed. Prefer fetchBIRateSeries() when you want the history or
 * want to distinguish a live read from a fallback.
 *
 * @returns {Promise<number>}
 */
export async function fetchBIRate() {
  try {
    const { current, effective } = await fetchBIRateSeries();
    console.log(`  ✅ BI-Rate ${(current * 100).toFixed(2)}% (effective ${effective})\n`);
    return current;
  } catch (err) {
    console.warn(`  ⚠️  BI-Rate fetch failed (${err.message}); using fallback ${(BI_RATE_FALLBACK * 100).toFixed(2)}%\n`);
    return BI_RATE_FALLBACK;
  }
}
