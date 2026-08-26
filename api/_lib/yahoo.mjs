/**
 * api/_lib/yahoo.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared Yahoo Finance access for the workbench serverless functions.
 *
 * Files under api/ whose name starts with `_` are NOT routed by Vercel, so this
 * is a plain library module.
 *
 * Sibling implementations — this module mirrors their conventions (yahoo-finance2
 * v3 .chart(), the `.JK` suffix, the Jakarta calendar, last-completed-bar trimming)
 * so a ticker fetched here is byte-shape-identical to one fetched by the CLI:
 *   • portfolio-app/data/fetch-snapshot.js            (optimizer snapshot)
 *   • backtest-portfolio/scripts/fetch-backtest-history.mjs  (walk-forward history)
 * Those two feed the committed snapshot, the write-once view-history captures, and
 * four CI workflows, so they are intentionally left on their own copy of this logic.
 * Any convention change here must be mirrored there (and vice-versa).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import YahooFinance from 'yahoo-finance2'; // v3 — capitalised class import

/** One client per warm lambda: yahoo-finance2 caches its cookie+crumb on the instance. */
export const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

/** IDX market calendar — every end date is resolved on Jakarta time, not local/UTC. */
const JAKARTA_TZ = 'Asia/Jakarta';

/** Pull history from here; Yahoo returns from each name's actual listing onward. */
export const HISTORY_START = '2011-01-01';

/** Jakarta Composite Index (IHSG) — the benchmark both apps overlay. */
export const BENCHMARK_TICKER = '^JKSE';

/** Yahoo quoteSummary modules needed for the optimizer's asset profile. */
export const QUOTE_SUMMARY_MODULES = [
  'financialData',
  'summaryDetail',
  'defaultKeyStatistics',
  'assetProfile',
  'summaryProfile',
];

/**
 * r_f lives in portfolio-app/data/bi-rate.js — the single source of truth, whose archive
 * (bi-rate.json) every app reads and which only refresh-bi-rate.js ever writes. This module
 * does NOT scrape BI; see api/rf.mjs.
 */
export { BI_RATE_FALLBACK } from '../../portfolio-app/data/bi-rate.js';

// ── Date helpers (Jakarta calendar, UTC-safe) ─────────────────────────────────

export function jakartaISO(refDate = new Date()) {
  return refDate.toLocaleDateString('en-CA', { timeZone: JAKARTA_TZ });
}

export function addCalendarDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Weekday in Jakarta: 0 Sun … 6 Sat. */
function jakartaWeekday(refDate = new Date()) {
  const label = refDate.toLocaleDateString('en-US', { timeZone: JAKARTA_TZ, weekday: 'short' });
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[label];
}

/** Last completed Friday — Yahoo's in-progress weekly bar carries null/unstable closes. */
export function lastCompletedFridayISO(refDate = new Date()) {
  const day = jakartaWeekday(refDate);
  const daysBack = day >= 5 ? day - 5 : day + 2;
  const offset = day === 5 ? 7 : daysBack;
  return addCalendarDays(jakartaISO(refDate), -offset);
}

/** Last completed IDX session (yesterday in Jakarta). */
export function lastCompletedTradingDayISO(refDate = new Date()) {
  return addCalendarDays(jakartaISO(refDate), -1);
}

/** period2 is exclusive-ish — use tomorrow (Jakarta) so the latest settled bar is included. */
export function chartEndISO(refDate = new Date()) {
  return addCalendarDays(jakartaISO(refDate), 1);
}

// ── Ticker normalisation ──────────────────────────────────────────────────────

/**
 * Normalises free-text user input to a Yahoo IDX symbol, or null if it can't be one.
 * Accepts 'bbca', 'BBCA', 'BBCA.JK'; rejects empty, over-long, and non-alphanumeric
 * input. IDX-only by design: the sector caps, the cost model, and the IHSG benchmark
 * all assume `.JK` names.
 * @param {string} raw
 * @returns {string|null} e.g. 'BBCA.JK'
 */
export function normaliseSymbol(raw) {
  if (typeof raw !== 'string') return null;
  const bare = raw.trim().toUpperCase().replace(/\.JK$/, '');
  if (!/^[A-Z0-9]{1,10}$/.test(bare)) return null;
  return `${bare}.JK`;
}

/** 'BBCA.JK' → 'BBCA' (bare symbol used in snapshots & portfolios.json). */
export const toBare = t => t.replace('.JK', '');

// ── Fetch + serialise ─────────────────────────────────────────────────────────

/**
 * Converts adjusted closing prices into decimal daily log-returns (oldest → newest).
 * Rounded to 6 dp to match fetch-snapshot.js exactly.
 * @param {number[]} prices
 * @returns {number[]}
 */
export function toDecimalLogReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] != null && prices[i - 1] != null && prices[i - 1] > 0) {
      returns.push(+(Math.log(prices[i] / prices[i - 1]).toFixed(6)));
    }
  }
  return returns;
}

/**
 * Price history via chart(); drops unsettled bars (null close/adjclose). Keeps raw close
 * + volume so the backtest can derive its point-in-time liquidity (dollar-volume) series.
 * historical() throws on Yahoo's partial-null rows, hence chart().
 * @param {string} ticker
 * @param {{ period1: string, period2: string, interval: string }} opts
 * @returns {Promise<Array<{date: string, adjClose: number, close: number, volume: number}>>}
 */
export async function fetchPriceHistory(ticker, { period1, period2, interval }) {
  const result = await yahooFinance.chart(ticker, { period1, period2, interval });
  const quotes = result.quotes ?? [];
  quotes.sort((a, b) => new Date(a.date) - new Date(b.date));
  return quotes
    .filter(q => q?.date && (q.adjclose != null || q.close != null))
    .map(q => ({
      date: new Date(q.date).toISOString().slice(0, 10),
      adjClose: q.adjclose != null ? q.adjclose : q.close,
      close: q.close != null ? q.close : q.adjclose,
      volume: q.volume ?? 0,
    }));
}

/**
 * { date, adjClose, close, volume }[] → compact { dates[], adjClose[] }, trimmed to
 * <= isoEnd. With { withDollarVol }, also emits dollarVol[] = raw close × volume
 * (rupiah traded per bar) — the liquidity proxy that drives per-asset trading costs.
 * @param {Array<object>} history
 * @param {string} isoEnd
 * @param {{ withDollarVol?: boolean }} [opts]
 */
export function serialize(history, isoEnd, { withDollarVol = false } = {}) {
  const dates = [];
  const adjClose = [];
  const dollarVol = withDollarVol ? [] : null;
  for (const row of history) {
    if (row.adjClose == null || row.date > isoEnd) continue;
    dates.push(row.date);
    adjClose.push(+row.adjClose.toFixed(4));
    if (withDollarVol) {
      const px = row.close ?? row.adjClose;
      dollarVol.push(Math.round((px ?? 0) * (row.volume ?? 0)));
    }
  }
  return withDollarVol ? { dates, adjClose, dollarVol } : { dates, adjClose };
}

// ── Transient-failure retry ───────────────────────────────────────────────────

/**
 * Runs `fn`, retrying once after a short delay. Yahoo's crumb/cookie pair expires
 * unpredictably and surfaces as a 401/429 or an "Invalid Crumb" error; a second
 * attempt on a fresh client almost always succeeds. Non-transient failures (a bad
 * symbol → 404) are re-thrown immediately so the caller can 404 the request.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    await new Promise(r => setTimeout(r, 600));
    return fn();
  }
}

function isTransient(err) {
  const msg = String(err?.message ?? err);
  if (/crumb|cookie/i.test(msg)) return true;
  const status = err?.response?.status ?? err?.status;
  return status === 401 || status === 429 || status === 500 || status === 502 || status === 503;
}

/** True when the error means "Yahoo has no such symbol" rather than "try again". */
export function isNotFound(err) {
  const msg = String(err?.message ?? err);
  const status = err?.response?.status ?? err?.status;
  return status === 404 || /not found|no data found|invalid symbol/i.test(msg);
}
