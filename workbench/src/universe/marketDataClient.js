/**
 * marketDataClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches the live market payload for an arbitrary ticker universe and reshapes it
 * into the two JSON contracts the existing engines already consume:
 *
 *   toOptimizerSnapshot() → live-market-snapshot.json shape  (portfolio-app/src/App.jsx)
 *   toBacktestHistory()   → backtest-history.json  shape     (backtest-portfolio/src/backtestEngine.js)
 *
 * Reproducing the contracts here — rather than changing the engines — is what keeps
 * ~3,300 lines of validated quant code untouched by the live-data feature.
 *
 * Pure of React. No DOM beyond fetch/localStorage-free logic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { toJK, toBare } from '../../../portfolio-app/data/universe.js';

/**
 * Parallel /api/ticker requests in flight. Deliberately modest: the deployment is
 * public and every miss is an upstream Yahoo call. Edge caching (s-maxage=21600)
 * absorbs repeat visits, so this only bounds the cold path.
 */
const CONCURRENCY = 5;

/** Per-session memo: symbol → payload. Removing a ticker costs 0 requests; adding costs 1. */
const cache = new Map();

/** History window shared by both contracts; mirrors HISTORY_START in api/_lib/yahoo.mjs. */
const HISTORY_START = '2011-01-01';

export function cachedSymbols() {
  return [...cache.keys()];
}

/** Drops memoised payloads so the next load re-hits the API (edge cache still applies). */
export function clearCache(symbols) {
  if (!symbols) cache.clear();
  else for (const s of symbols) cache.delete(toJK(s));
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body (a proxy error page, say) — fall through to the status-based message.
  }
  if (!res.ok) {
    const err = new Error(body?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body?.error;
    throw err;
  }
  return body;
}

/**
 * Runs `task` over `items` with a bounded number in flight, preserving input order in
 * the result. Rejections are captured per item rather than aborting the whole batch —
 * one dead ticker must not sink a 25-name load.
 */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await task(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Validates a user-typed ticker before committing to a full ~130 KB fetch. */
export async function resolveSymbol(raw, { signal } = {}) {
  return getJson(`/api/resolve?symbol=${encodeURIComponent(raw)}`, signal);
}

/**
 * Loads every symbol in `symbols` plus the IHSG benchmark and the BI-Rate.
 *
 * @param {string[]} symbols  `.JK`-suffixed or bare; normalised here.
 * @param {{ onProgress?: (p:{done:number,total:number,label:string}) => void,
 *           signal?: AbortSignal, force?: boolean }} [opts]
 * @returns {Promise<{ tickers: object[], failures: {symbol:string,message:string}[],
 *                     benchmark: object, rf: object, generated: string }>}
 */
export async function loadUniverse(symbols, { onProgress, signal, force = false } = {}) {
  const wanted = [...new Set(symbols.map(toJK))];
  if (force) clearCache(wanted);

  const missing = wanted.filter(s => !cache.has(s));
  // +2 for the benchmark and the risk-free rate, which are universe-independent.
  const total = missing.length + 2;
  let done = 0;
  const tick = (label) => {
    done += 1;
    onProgress?.({ done, total, label });
  };

  onProgress?.({ done: 0, total, label: missing.length ? 'Fetching market data…' : 'Using cached data…' });

  const [benchmark, rf, fetched] = await Promise.all([
    getJson('/api/benchmark', signal).then(b => { tick('IHSG benchmark'); return b; }),
    getJson('/api/rf', signal).then(r => { tick('BI-Rate'); return r; }),
    mapLimit(missing, CONCURRENCY, async (symbol) => {
      const payload = await getJson(`/api/ticker?symbol=${encodeURIComponent(symbol)}`, signal);
      tick(toBare(symbol));
      return payload;
    }),
  ]);

  const failures = [];
  fetched.forEach((r, i) => {
    if (r.ok) cache.set(missing[i], r.value);
    else failures.push({ symbol: toBare(missing[i]), message: r.error?.message ?? 'fetch failed' });
  });

  return {
    tickers: wanted.map(s => cache.get(s)).filter(Boolean),
    failures,
    benchmark,
    rf,
    generated: new Date().toISOString(),
  };
}

// ── Contract adapters ─────────────────────────────────────────────────────────

/**
 * → the `live-market-snapshot.json` shape consumed by portfolio-app/src/App.jsx.
 * `historyRange.end` is the OLDEST weeklyEnd across the batch: tickers fetched either
 * side of a Jakarta day boundary can differ by one bar, and the shared window must be
 * one every asset actually covers.
 */
export function toOptimizerSnapshot({ tickers, benchmark, rf, generated }) {
  const weeklyEnds = tickers.map(t => t.weeklyEnd).filter(Boolean);
  const end = weeklyEnds.length ? weeklyEnds.slice().sort()[0] : (benchmark?.weeklyEnd ?? null);

  return {
    generated,
    description: 'IDX Live Universe — fetched on demand from Yahoo Finance via /api',
    riskFreeRate: rf?.riskFreeRate ?? 0.0575,
    riskFreeRateEffective: rf?.effective ?? null,
    historyRange: { start: HISTORY_START, end, interval: '1wk' },
    benchmark: benchmark
      ? { ticker: benchmark.ticker, yahooTicker: benchmark.yahooTicker, priceHistory: benchmark.weekly }
      : null,
    assets: tickers.map(t => ({
      ticker: t.ticker,
      name: t.name,
      sector: t.sector,
      meta: t.meta,
      forwardEstimates: t.forwardEstimates,
      priceHistory: t.weekly,
    })),
  };
}

/**
 * → the `backtest-history.json` shape consumed by backtest-portfolio/src/backtestEngine.js.
 * `sharesOut` comes from Yahoo's defaultKeyStatistics (current value only — the engine's
 * documented constant-share-count approximation for the BL-equilibrium prior).
 *
 * `riskFreeRateSeries` is REQUIRED, not optional decoration: the engine scores each
 * rebalance at the BI-Rate in effect on that date via makeRateLookup(). Omit it and it
 * silently degrades to a constant r_f (`riskFreeRateMode: 'constant'`), so the workbench's
 * Sharpe would quietly disagree with the standalone app's over the same window.
 */
export function toBacktestHistory({ tickers, benchmark, rf, generated }) {
  const pickOldest = (vals) => (vals.length ? vals.slice().sort()[0] : null);
  return {
    generated,
    riskFreeRate: rf?.riskFreeRate ?? 0.0575,
    riskFreeRateSeries: rf?.history ?? [],
    weeklyEnd: pickOldest(tickers.map(t => t.weeklyEnd).filter(Boolean)) ?? benchmark?.weeklyEnd ?? null,
    dailyEnd: pickOldest(tickers.map(t => t.dailyEnd).filter(Boolean)),
    tickers: tickers.map(t => ({
      ticker: t.ticker,
      listing: t.listing,
      sharesOut: t.meta?.sharesOutstanding ?? null,
      weekly: { dates: t.weekly.dates, adjClose: t.weekly.adjClose },
      daily: t.daily,
    })),
    benchmark: benchmark
      ? { ticker: benchmark.ticker, yahooTicker: benchmark.yahooTicker, weekly: benchmark.weekly }
      : null,
  };
}

/**
 * Stable identity for a loaded dataset. The backtest worker caches its history by this
 * string and re-inits only when it changes, so repeat runs don't re-clone ~3 MB.
 */
export function dataVersion({ tickers, generated }) {
  return `${generated}|${tickers.map(t => t.ticker).sort().join(',')}`;
}

/**
 * How current the loaded data actually is. `lastBar` is the newest daily close present —
 * the number a user would check against their broker. It trails today by design: Yahoo
 * only publishes a settled bar, so the newest is normally the previous session.
 *
 * Worth surfacing prominently: on a deployed (CDN-cached) build a response can be served
 * from the edge some hours after it was fetched, and without an as-of date on screen
 * there is no way to tell live data from cached data.
 */
export function dataAsOf({ tickers, generated }) {
  const newest = (key) => {
    const ds = tickers.map(t => t[key]?.dates?.at(-1)).filter(Boolean).sort();
    return ds.length ? ds[ds.length - 1] : null;
  };
  return { lastBar: newest('daily'), lastWeekly: newest('weekly'), fetchedAt: generated };
}
