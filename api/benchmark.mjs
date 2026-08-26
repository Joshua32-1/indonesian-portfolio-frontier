/**
 * api/benchmark.mjs — GET /api/benchmark
 * ─────────────────────────────────────────────────────────────────────────────
 * IHSG (Jakarta Composite, Yahoo `^JKSE`) weekly history — the benchmark overlay
 * both apps use. Universe-independent, so it is one request per fan-out regardless
 * of how many tickers the user has selected.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  BENCHMARK_TICKER,
  HISTORY_START,
  chartEndISO,
  fetchPriceHistory,
  lastCompletedFridayISO,
  serialize,
  withRetry,
} from './_lib/yahoo.mjs';
import { MARKET_CACHE, sendJson, withErrorHandling } from './_lib/http.mjs';

export default withErrorHandling(async (_req, res) => {
  const now = new Date();
  const weeklyEnd = lastCompletedFridayISO(now);

  const raw = await withRetry(() => fetchPriceHistory(BENCHMARK_TICKER, {
    period1: HISTORY_START,
    period2: chartEndISO(now),
    interval: '1wk',
  }));

  sendJson(res, 200, {
    ticker: 'IHSG',
    yahooTicker: BENCHMARK_TICKER,
    weeklyEnd,
    weekly: { interval: '1wk', ...serialize(raw, weeklyEnd) },
  }, MARKET_CACHE);
});
