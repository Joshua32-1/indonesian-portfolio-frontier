/**
 * fetch-snapshot.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js ESM script (run via: node data/fetch-snapshot.js)
 *
 * Fetches weekly price history and daily returns for IDX tickers plus IHSG,
 * analyst forward targets, dividend yield, and theta-decay volatility estimates.
 * Writes the complete payload to ./live-market-snapshot.json.
 *
 * After changing TICKERS, re-run this script (or `npm run fetch-snapshot`).
 * Industry labels (Yahoo assetProfile.industry) are stored in asset.sector for
 * concentration caps — finer than GICS sector (e.g. Conglomerates vs Railroads).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import YahooFinance from 'yahoo-finance2'; // v3 — capitalised class import
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  computeThetaDecayedVol,
  DEFAULT_VOL_HALF_LIFE,
  VOL_LOOKBACK_DAYS,
} from '../src/math/matrixEngine.js';
import { resolveSectorFromQuoteSummary } from '../src/math/assetSector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── Configuration ─────────────────────────────────────────────────────────────

/** IDX tickers to include in the snapshot. */
const TICKERS = [
  'BBCA.JK', 'BBRI.JK', 'BMRI.JK', 'TLKM.JK', 'ASII.JK', 'BIRD.JK',
  'INDF.JK', 'ICBP.JK', 'JSMR.JK', 'KLBF.JK', 'SIDO.JK', 'ANTM.JK',
  'BBNI.JK', 'BNGA.JK', 'CMRY.JK', 'PWON.JK', 'AMRT.JK', 'INCO.JK', 
  'NCKL.JK', 'MDKA.JK', 'AADI.JK', 'UNTR.JK', 'LSIP.JK', 'CPIN.JK',
  'ISAT.JK'
];

/** Yahoo Finance quoteSummary modules used per ticker. */
const QUOTE_SUMMARY_MODULES = [
  'financialData',
  'summaryDetail',
  'defaultKeyStatistics',
  'assetProfile',
  'summaryProfile',
];

/** Full history window for weekly price chart + correlation date picker. */
const FULL_HISTORY = { start: '2011-01-01', interval: '1wk' };

/** Jakarta Composite Index (IHSG) — benchmark overlay on correlation chart. */
const BENCHMARK_TICKER = '^JKSE';

/** Theta-decay half-life for volatility weighting (trading days). */
const VOL_HALF_LIFE = DEFAULT_VOL_HALF_LIFE;

// ── Utility helpers ───────────────────────────────────────────────────────────

/**
 * Converts adjusted closing prices into decimal daily log-returns (oldest → newest).
 * @param {number[]} prices
 * @returns {number[]}
 */
function toDecimalLogReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] != null && prices[i - 1] != null && prices[i - 1] > 0) {
      returns.push(+(Math.log(prices[i] / prices[i - 1]).toFixed(6)));
    }
  }
  return returns;
}

/**
 * ISO date string for `daysAgo` calendar days before `refDate`.
 * @param {Date} refDate
 * @param {number} daysAgo
 * @returns {string}
 */
function isoDaysAgo(refDate, daysAgo) {
  const d = new Date(refDate);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date (YYYY-MM-DD) — used as the rolling history end. */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Serialises Yahoo weekly history into a compact { dates, adjClose } payload
 * for frontend charting and date-range correlation.
 * @param {Array<{date: Date, adjClose: number}>} history
 * @returns {{ interval: string, dates: string[], adjClose: number[] }}
 */
function serializePriceHistory(history) {
  const dates = [];
  const adjClose = [];
  for (const row of history) {
    if (row.adjClose == null) continue;
    dates.push(new Date(row.date).toISOString().slice(0, 10));
    adjClose.push(+row.adjClose.toFixed(4));
  }
  return { interval: '1wk', dates, adjClose };
}

// ── Main extraction loop ──────────────────────────────────────────────────────

async function buildSnapshot() {
  console.log('🚀  IDX Portfolio Snapshot — Yahoo Finance v3\n');

  const historyEnd = '2026-05-25';
  const volEnd = historyEnd;
  const volStart = isoDaysAgo(new Date(volEnd), 400); // ~1.1 calendar years → ≥252 trading days

  const assetProfiles = [];

  for (const ticker of TICKERS) {
    try {
      console.log(`  ↳ Fetching ${ticker} …`);

      // ── 1. Full 5-year weekly history ──────────────────────────────────────
      const rawHistory = await yahooFinance.historical(ticker, {
        period1:  FULL_HISTORY.start,
        period2:  historyEnd,
        interval: FULL_HISTORY.interval,
      });

      // Sort ascending — Yahoo occasionally returns in reverse order
      rawHistory.sort((a, b) => new Date(a.date) - new Date(b.date));

      // ── 2. Theta-decay daily vol (1-year lookback, recent days weighted higher) ─
      const dailyHistory = await yahooFinance.historical(ticker, {
        period1:  volStart,
        period2:  volEnd,
        interval: '1d',
      });
      dailyHistory.sort((a, b) => new Date(a.date) - new Date(b.date));
      const dailyPrices = dailyHistory.map(d => d.adjClose).filter(Boolean);
      const dailyReturns = toDecimalLogReturns(dailyPrices).slice(-VOL_LOOKBACK_DAYS);
      const recentDailyVol = computeThetaDecayedVol(dailyReturns, VOL_HALF_LIFE);

      // ── 3. Analyst forward estimates, dividend yield, mcap, liquidity ───
      const summary = await yahooFinance.quoteSummary(ticker, {
        modules: QUOTE_SUMMARY_MODULES,
      });
      const fd = summary.financialData ?? {};
      const sd = summary.summaryDetail ?? {};
      const ks = summary.defaultKeyStatistics ?? {};
      const sector = resolveSectorFromQuoteSummary(summary);

      const currentPrice  = fd.currentPrice ?? sd.regularMarketPrice ?? null;
      const marketCap     = sd.marketCap ?? ks.marketCap ?? null;
      const averageVolume = sd.averageVolume ?? sd.averageVolume10days ?? null;
      const floatShares   = ks.floatShares ?? null;
      const sharesOutstanding = ks.sharesOutstanding ?? null;
      const avgDailyTurnover = (averageVolume != null && currentPrice != null)
        ? averageVolume * currentPrice
        : null;
      const freeFloatPct = (floatShares != null && sharesOutstanding != null && sharesOutstanding > 0)
        ? floatShares / sharesOutstanding
        : null;

      // ── 4. Assemble asset profile ──────────────────────────────────────────
      assetProfiles.push({
        ticker: ticker.replace('.JK', ''),
        name:   summary.assetProfile?.longName ?? summary.price?.longName ?? ticker,
        sector,
        meta: {
          currentPrice,
          dividendYield:  sd.dividendYield  ?? 0,   // decimal yield (e.g. 0.057 = 5.7%)
          marketCap,
          averageVolume,
          floatShares,
          sharesOutstanding,
          avgDailyTurnover,
          freeFloatPct,
          recentDailyVol,
          dailyReturns,
          volHalfLife:    VOL_HALF_LIFE,
        },
        forwardEstimates: {
          lowTarget:     fd.targetLowPrice   ?? null,
          meanTarget:    fd.targetMeanPrice  ?? null,
          highTarget:    fd.targetHighPrice  ?? null,
          totalAnalysts: fd.numberOfAnalystOpinions ?? 0,
        },
        priceHistory: serializePriceHistory(rawHistory),
      });

      console.log(`  ✅ ${ticker} done  (${sector}, θ-vol: ${(recentDailyVol * 100).toFixed(2)}% daily, ${dailyReturns.length}d)\n`);

    } catch (err) {
      console.error(`  ❌ ${ticker} failed:`, err.message, '\n');
    }
  }

  // ── 6. IHSG benchmark history ───────────────────────────────────────────────
  let benchmark = null;
  try {
    console.log('  ↳ Fetching IHSG benchmark (^JKSE) …');
    const rawBench = await yahooFinance.historical(BENCHMARK_TICKER, {
      period1:  FULL_HISTORY.start,
      period2:  historyEnd,
      interval: FULL_HISTORY.interval,
    });
    rawBench.sort((a, b) => new Date(a.date) - new Date(b.date));
    benchmark = {
      ticker:       'IHSG',
      yahooTicker:  BENCHMARK_TICKER,
      priceHistory: serializePriceHistory(rawBench),
    };
    console.log(`  ✅ IHSG done  (${benchmark.priceHistory.dates.length} weekly bars)\n`);
  } catch (err) {
    console.error('  ❌ IHSG benchmark failed:', err.message, '\n');
  }

  // ── 7. Write snapshot ──────────────────────────────────────────────────────
  const snapshot = {
    generated:    new Date().toISOString(),
    description:  'IDX Large-Cap Live Snapshot — fetched from Yahoo Finance v3',
    riskFreeRate: 0.0525, // BI 7-day reverse repo rate as of May 2026
    historyRange: { start: FULL_HISTORY.start, end: historyEnd, interval: '1wk' },
    benchmark,
    assets:       assetProfiles,
  };

  const outPath = join(__dirname, 'live-market-snapshot.json');
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n📦  Snapshot written → ${outPath}`);
  console.log(`    ${assetProfiles.length} assets\n`);
}

buildSnapshot().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
