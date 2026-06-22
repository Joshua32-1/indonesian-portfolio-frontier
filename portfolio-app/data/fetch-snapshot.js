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
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

/** IDX market calendar — all snapshot end dates use Jakarta, not local/UTC. */
const JAKARTA_TZ = 'Asia/Jakarta';

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

/** Official Bank Indonesia BI-Rate table (English page; most-recent decision first). */
const BI_RATE_URL = 'https://www.bi.go.id/en/statistik/indikator/bi-rate.aspx';

/** Last-known BI-Rate (decimal) — used if the live fetch fails so the snapshot never breaks. */
const BI_RATE_FALLBACK = 0.0575; // 5.75% as of 18 June 2026

/** Sanity bounds for a parsed policy rate (decimal). Rejects garbage like a stray "100 %". */
const BI_RATE_MIN = 0.01;
const BI_RATE_MAX = 0.15;

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
 * YYYY-MM-DD on the Jakarta calendar for `refDate`.
 * @param {Date} [refDate]
 * @returns {string}
 */
function jakartaISO(refDate = new Date()) {
  return refDate.toLocaleDateString('en-CA', { timeZone: JAKARTA_TZ });
}

/**
 * Adds calendar days to a YYYY-MM-DD string (UTC-safe; avoids local/UTC drift).
 * @param {string} isoDate
 * @param {number} days
 * @returns {string}
 */
function addCalendarDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Weekday in Jakarta: 0 Sun … 6 Sat. */
function jakartaWeekday(refDate = new Date()) {
  const label = refDate.toLocaleDateString('en-US', {
    timeZone: JAKARTA_TZ,
    weekday: 'short',
  });
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[label];
}

/**
 * Last completed Friday (YYYY-MM-DD, Jakarta).
 * Yahoo's in-progress weekly bar has null close/adjClose — exclude the open week.
 * @param {Date} [refDate]
 * @returns {string}
 */
function lastCompletedFridayISO(refDate = new Date()) {
  const day = jakartaWeekday(refDate);
  const daysBack = day >= 5 ? day - 5 : day + 2;
  const offset = day === 5 ? 7 : daysBack;
  return addCalendarDays(jakartaISO(refDate), -offset);
}

/** Last completed IDX session (yesterday in Jakarta). */
function lastCompletedTradingDayISO(refDate = new Date()) {
  return addCalendarDays(jakartaISO(refDate), -1);
}

/**
 * Price history via chart(); drops unsettled bars (null close/adjclose).
 * historical() throws on Yahoo's partial-null rows (e.g. corrupted 2026-06-01 IDX bar).
 * @param {string} ticker
 * @param {{ period1: string, period2: string, interval: string }} opts
 * @returns {Promise<Array<{ date: Date, adjClose?: number, close?: number }>>}
 */
async function fetchPriceHistory(ticker, { period1, period2, interval }) {
  const result = await yahooFinance.chart(ticker, { period1, period2, interval });
  const quotes = result.quotes ?? [];
  quotes.sort((a, b) => new Date(a.date) - new Date(b.date));

  return quotes
    .filter(q => q?.date && (q.adjclose != null || q.close != null))
    .map(({ adjclose, ...rest }) => {
      const row = { ...rest };
      if (adjclose != null) row.adjClose = adjclose;
      if (row.close == null && adjclose != null) row.close = adjclose;
      return row;
    });
}

/**
 * Serialises Yahoo weekly history into a compact { dates, adjClose } payload
 * for frontend charting and date-range correlation.
 * @param {Array<{date: Date, adjClose: number}>} history
 * @returns {{ interval: string, dates: string[], adjClose: number[] }}
 */
/** Drops weekly bars dated after `isoEnd` (open week can still have a non-null adjClose). */
function throughDate(history, isoEnd) {
  return history.filter(row => new Date(row.date).toISOString().slice(0, 10) <= isoEnd);
}

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

/**
 * Live BI-Rate (decimal) scraped from Bank Indonesia's official indicator page.
 * The EN page renders the policy-rate history as a most-recent-first table:
 *   <td>18 June 2026</td><td>5.75 %</td>… → we take the first date+rate pair.
 * Falls back to BI_RATE_FALLBACK on any network/parse/validation failure so the
 * snapshot is always written.
 * @returns {Promise<number>}
 */
async function fetchBIRate() {
  try {
    const res = await fetch(BI_RATE_URL, {
      headers: {
        // BI's SharePoint backend stalls on non-browser requests — send real browser headers.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const body = html.slice(html.indexOf('<tbody'));
    // First "<date></td> <td>rate %" pair = latest decision (table is newest-first).
    const m = body.match(/(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*<\/td>\s*<td[^>]*>\s*(\d+(?:\.\d+)?)\s*%/);
    if (!m) throw new Error('rate cell not found in table');

    const rate = parseFloat(m[2]) / 100;
    if (!Number.isFinite(rate) || rate < BI_RATE_MIN || rate > BI_RATE_MAX) {
      throw new Error(`parsed rate out of range: ${m[2]}%`);
    }

    console.log(`  ✅ BI-Rate ${m[2]}% (effective ${m[1]})\n`);
    return +rate.toFixed(6);
  } catch (err) {
    console.warn(`  ⚠️  BI-Rate fetch failed (${err.message}); using fallback ${(BI_RATE_FALLBACK * 100).toFixed(2)}%\n`);
    return BI_RATE_FALLBACK;
  }
}

// ── Main extraction loop ──────────────────────────────────────────────────────

async function buildSnapshot() {
  console.log('🚀  IDX Portfolio Snapshot — Yahoo Finance v3\n');

  console.log('  ↳ Fetching BI-Rate (Bank Indonesia) …');
  const riskFreeRate = await fetchBIRate();

  const now = new Date();
  const weeklyEnd = lastCompletedFridayISO(now);
  const dailyEnd  = lastCompletedTradingDayISO(now);
  const volStart  = addCalendarDays(dailyEnd, -400); // ~1.1 calendar years → ≥252 trading days
  // chart period2 is exclusive-ish; use tomorrow Jakarta so the latest settled bar is included
  const chartEnd  = addCalendarDays(jakartaISO(now), 1);

  const assetProfiles = [];

  for (const ticker of TICKERS) {
    try {
      console.log(`  ↳ Fetching ${ticker} …`);

      // ── 1. Full 5-year weekly history ──────────────────────────────────────
      let rawHistory = await fetchPriceHistory(ticker, {
        period1:  FULL_HISTORY.start,
        period2:  chartEnd,
        interval: FULL_HISTORY.interval,
      });

      rawHistory.sort((a, b) => new Date(a.date) - new Date(b.date));
      rawHistory = throughDate(rawHistory, weeklyEnd);

      // ── 2. Theta-decay daily vol (1-year lookback, recent days weighted higher) ─
      const dailyHistory = await fetchPriceHistory(ticker, {
        period1:  volStart,
        period2:  chartEnd,
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
    const rawBench = await fetchPriceHistory(BENCHMARK_TICKER, {
      period1:  FULL_HISTORY.start,
      period2:  chartEnd,
      interval: FULL_HISTORY.interval,
    });
    rawBench.sort((a, b) => new Date(a.date) - new Date(b.date));
    const benchHistory = throughDate(rawBench, weeklyEnd);
    benchmark = {
      ticker:       'IHSG',
      yahooTicker:  BENCHMARK_TICKER,
      priceHistory: serializePriceHistory(benchHistory),
    };
    console.log(`  ✅ IHSG done  (${benchmark.priceHistory.dates.length} weekly bars)\n`);
  } catch (err) {
    console.error('  ❌ IHSG benchmark failed:', err.message, '\n');
  }

  // ── 7. Write snapshot ──────────────────────────────────────────────────────
  const snapshot = {
    generated:    new Date().toISOString(),
    description:  'IDX Large-Cap Live Snapshot — fetched from Yahoo Finance v3',
    riskFreeRate, // live BI-Rate scraped from Bank Indonesia (see fetchBIRate)
    historyRange: { start: FULL_HISTORY.start, end: weeklyEnd, interval: '1wk' },
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
