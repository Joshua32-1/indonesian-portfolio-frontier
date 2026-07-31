/**
 * bi-rate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The definitive Bank Indonesia policy-rate (BI-Rate) source — the SINGLE SOURCE
 * OF TRUTH for r_f, imported by every app that needs a risk-free rate:
 *   • portfolio-app/data/fetch-snapshot.js            (optimizer snapshot)
 *   • portfolio-app/data/refresh-bi-rate.js           (weekday cron refresher)
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
 * The companion cache `bi-rate.json` (committed, refreshed by refresh-bi-rate.js) holds
 * the parsed decision history so a stalled BI backend degrades to the last cron-verified
 * rate rather than a literal frozen at authoring time.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Constants ────────────────────────────────────────────────────────────────

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
    rows.push({ effective, rate });
  }

  // The page is authored newest-first, but don't rely on it.
  rows.sort((a, b) => (a.effective < b.effective ? 1 : a.effective > b.effective ? -1 : 0));
  return rows;
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
