/**
 * api/ticker.mjs — GET /api/ticker?symbol=BBCA.JK
 * ─────────────────────────────────────────────────────────────────────────────
 * One IDX name's complete market payload: the UNION of what the optimizer and the
 * backtester each need, so a single fan-out feeds both tabs of the workbench.
 *
 *   optimizer asset  = { ticker, name, sector, meta, forwardEstimates,
 *                        priceHistory: <weekly> }        ← live-market-snapshot.json
 *   backtest ticker  = { ticker, listing, sharesOut, weekly, daily }
 *                                                        ← backtest-history.json
 *
 * Both shapes are derived client-side in workbench/src/universe/marketDataClient.js.
 * Deriving rather than duplicating is what lets portfolio-app/src/App.jsx and
 * backtest-portfolio/src/backtestEngine.js consume this with no math changes.
 *
 * `recentDailyVol` and `sector` are computed here with the same pure helpers the
 * CLI snapshot uses (computeThetaDecayedVol / resolveSectorFromQuoteSummary), so a
 * ticker fetched live matches one fetched by `npm run fetch-snapshot`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  HISTORY_START,
  QUOTE_SUMMARY_MODULES,
  chartEndISO,
  fetchPriceHistory,
  isNotFound,
  lastCompletedFridayISO,
  lastCompletedTradingDayISO,
  normaliseSymbol,
  serialize,
  toBare,
  toDecimalLogReturns,
  withRetry,
  yahooFinance,
} from './_lib/yahoo.mjs';
import { MARKET_CACHE, queryParam, sendJson, withErrorHandling } from './_lib/http.mjs';
import {
  computeThetaDecayedVol,
  DEFAULT_VOL_HALF_LIFE,
  VOL_LOOKBACK_DAYS,
} from '../portfolio-app/src/math/matrixEngine.js';
import { resolveSectorFromQuoteSummary } from '../portfolio-app/src/math/assetSector.js';

export default withErrorHandling(async (req, res) => {
  const symbol = normaliseSymbol(queryParam(req, 'symbol'));
  if (!symbol) {
    return sendJson(res, 400, {
      error: 'bad_symbol',
      message: 'symbol must be an IDX ticker, e.g. BBCA or BBCA.JK',
    });
  }

  const now = new Date();
  const weeklyEnd = lastCompletedFridayISO(now);
  const dailyEnd = lastCompletedTradingDayISO(now);
  const chartEnd = chartEndISO(now);

  let weeklyRaw, dailyRaw, summary;
  try {
    [weeklyRaw, dailyRaw, summary] = await withRetry(() => Promise.all([
      fetchPriceHistory(symbol, { period1: HISTORY_START, period2: chartEnd, interval: '1wk' }),
      fetchPriceHistory(symbol, { period1: HISTORY_START, period2: chartEnd, interval: '1d' }),
      yahooFinance.quoteSummary(symbol, { modules: QUOTE_SUMMARY_MODULES }),
    ]));
  } catch (err) {
    if (isNotFound(err)) {
      return sendJson(res, 404, { error: 'not_found', message: `Yahoo has no data for ${symbol}` });
    }
    throw err;
  }

  const weekly = serialize(weeklyRaw, weeklyEnd);
  const daily = serialize(dailyRaw, dailyEnd, { withDollarVol: true });

  if (weekly.dates.length === 0 && daily.dates.length === 0) {
    return sendJson(res, 404, { error: 'no_history', message: `No price history for ${symbol}` });
  }

  // θ-decay vol over the trailing 252 sessions — same inputs and rounding as the CLI
  // snapshot, so the number matches live-market-snapshot.json for the same date.
  const dailyReturns = toDecimalLogReturns(daily.adjClose).slice(-VOL_LOOKBACK_DAYS);
  const recentDailyVol = computeThetaDecayedVol(dailyReturns, DEFAULT_VOL_HALF_LIFE);

  const fd = summary.financialData ?? {};
  const sd = summary.summaryDetail ?? {};
  const ks = summary.defaultKeyStatistics ?? {};

  const currentPrice = fd.currentPrice ?? sd.regularMarketPrice ?? null;
  const marketCap = sd.marketCap ?? ks.marketCap ?? null;
  const averageVolume = sd.averageVolume ?? sd.averageVolume10days ?? null;
  const floatShares = ks.floatShares ?? null;
  const sharesOutstanding = ks.sharesOutstanding ?? null;

  sendJson(res, 200, {
    ticker: toBare(symbol),
    yahooTicker: symbol,
    name: summary.assetProfile?.longName ?? summary.price?.longName ?? symbol,
    sector: resolveSectorFromQuoteSummary(summary),
    listing: daily.dates[0] ?? weekly.dates[0] ?? null,
    weeklyEnd,
    dailyEnd,
    meta: {
      currentPrice,
      dividendYield: sd.dividendYield ?? 0, // decimal yield (e.g. 0.057 = 5.7%)
      marketCap,
      averageVolume,
      floatShares,
      sharesOutstanding,
      avgDailyTurnover: (averageVolume != null && currentPrice != null)
        ? averageVolume * currentPrice
        : null,
      freeFloatPct: (floatShares != null && sharesOutstanding != null && sharesOutstanding > 0)
        ? floatShares / sharesOutstanding
        : null,
      recentDailyVol,
      dailyReturns,
      volHalfLife: DEFAULT_VOL_HALF_LIFE,
    },
    forwardEstimates: {
      lowTarget: fd.targetLowPrice ?? null,
      meanTarget: fd.targetMeanPrice ?? null,
      highTarget: fd.targetHighPrice ?? null,
      totalAnalysts: fd.numberOfAnalystOpinions ?? 0,
    },
    weekly: { interval: '1wk', ...weekly },
    daily,
  }, MARKET_CACHE);
});
