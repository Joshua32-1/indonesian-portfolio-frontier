/**
 * fetch-snapshot.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js ESM script (run via: node --experimental-vm-modules fetch-snapshot.js)
 *
 * Fetches 5-year weekly history from Yahoo Finance v3 for each IDX ticker,
 * then partitions the returns into two regime windows:
 *   • regularTimeline  → calm bull-market period  (2023-01-01 → 2024-12-31)
 *   • stressTimeline   → rate-hike bear market     (2022-01-01 → 2022-12-31)
 *
 * Also pulls analyst forward price targets via quoteSummary(financialData).
 * Writes the complete structured payload to ./live-market-snapshot.json.
 *
 * After changing TICKERS, you must re-run this script (or `npm run fetch-snapshot`).
 * The React app only reads live-market-snapshot.json — edits here are not picked up automatically.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import YahooFinance from 'yahoo-finance2'; // v3 — capitalised class import
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const yahooFinance = new YahooFinance();

// ── Configuration ─────────────────────────────────────────────────────────────

/** IDX tickers to include in the snapshot. */
const TICKERS = [
  'BBCA.JK', 'BBRI.JK', 'BMRI.JK', 'TLKM.JK', 'ASII.JK', 'BIRD.JK',
  'INDF.JK', 'ICBP.JK', 'JSMR.JK', 'KLBF.JK', 'SIDO.JK', 'SMDR.JK',
];

/** GICS-style sector tags for concentration-cap enforcement in the app. */
const TICKER_SECTORS = {
  'BBCA.JK': 'Banking',
  'BBRI.JK': 'Banking',
  'BMRI.JK': 'Banking',
  'TLKM.JK': 'Telecoms',
  'ASII.JK': 'Conglomerate',
  'BIRD.JK': 'Transport',
  'INDF.JK': 'Consumer',
  'ICBP.JK': 'Consumer',
  'JSMR.JK': 'Infrastructure',
  'KLBF.JK': 'Consumer',
  'SIDO.JK': 'Consumer',
  'SMDR.JK': 'Materials',
};

/**
 * Named regime windows.
 * Each window slices the full 5-year history into isolated return vectors.
 * Using weekly ('1wk') data to reduce noise while keeping 50–100+ observations
 * per regime window — the minimum recommended for a stable covariance estimate.
 */
const REGIMES = {
  /** Calm growth: post-COVID recovery, moderate IDX bull run. */
  regularTimeline: { start: '2023-01-01', end: '2024-12-31' },
  /** Stress:  US rate-hike cycle, EM capital outflows, IDX drawdown. */
  stressTimeline:  { start: '2022-01-01', end: '2022-12-31' },
};

/** Full 5-year window for recentDailyVol estimation. */
const FULL_HISTORY = { start: '2021-05-01', end: '2026-05-20', interval: '1wk' };

/** Last N trading days used to compute "recent" short-term volatility. */
const RECENT_VOL_WINDOW = 30;

// ── Utility helpers ───────────────────────────────────────────────────────────

/**
 * Converts an array of adjusted closing prices into percentage log-returns.
 * Log-returns are additive and better suited for MPT computations.
 * @param {number[]} prices
 * @returns {number[]} returns in % (e.g. 1.23 = +1.23%)
 */
function toLogReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] != null && prices[i - 1] != null && prices[i - 1] > 0) {
      returns.push(+(Math.log(prices[i] / prices[i - 1]) * 100).toFixed(4));
    }
  }
  return returns;
}

/**
 * Computes annualised daily volatility from a recent price slice.
 * σ_daily = std(daily log-returns);  reported as a decimal (0.0142 = 1.42%).
 * @param {number[]} recentPrices  — raw adjusted close array (most recent N days)
 * @returns {number}
 */
function computeRecentDailyVol(recentPrices) {
  const rets = toLogReturns(recentPrices).map(r => r / 100); // to decimal
  if (rets.length < 2) return 0.015; // safe fallback
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1);
  return +Math.sqrt(variance).toFixed(6);
}

/**
 * Slices a full history array (sorted ascending by date) into a date-bounded window.
 * @param {Array<{date: Date, adjClose: number}>} history
 * @param {string} startISO  — inclusive start date
 * @param {string} endISO    — inclusive end date
 * @returns {number[]} weekly log-return series in %
 */
function sliceRegime(history, startISO, endISO) {
  const start = new Date(startISO);
  const end   = new Date(endISO);
  const prices = history
    .filter(d => d.date >= start && d.date <= end && d.adjClose != null)
    .map(d => d.adjClose);
  return toLogReturns(prices);
}

// ── Main extraction loop ──────────────────────────────────────────────────────

async function buildSnapshot() {
  console.log('🚀  IDX Portfolio Snapshot — Yahoo Finance v3\n');

  const assetProfiles = [];

  for (const ticker of TICKERS) {
    try {
      console.log(`  ↳ Fetching ${ticker} …`);

      // ── 1. Full 5-year weekly history ──────────────────────────────────────
      const rawHistory = await yahooFinance.historical(ticker, {
        period1:  FULL_HISTORY.start,
        period2:  FULL_HISTORY.end,
        interval: FULL_HISTORY.interval,
      });

      // Sort ascending — Yahoo occasionally returns in reverse order
      rawHistory.sort((a, b) => new Date(a.date) - new Date(b.date));

      // ── 2. Recent daily vol (last 30 closes) ──────────────────────────────
      //    We re-fetch daily data for the vol window to keep it granular
      const dailyRecent = await yahooFinance.historical(ticker, {
        period1:  '2026-03-01',
        period2:  '2026-05-20',
        interval: '1d',
      });
      dailyRecent.sort((a, b) => new Date(a.date) - new Date(b.date));
      const recentPrices = dailyRecent
        .slice(-RECENT_VOL_WINDOW)
        .map(d => d.adjClose)
        .filter(Boolean);

      const recentDailyVol = computeRecentDailyVol(recentPrices);

      // ── 3. Analyst forward estimates ──────────────────────────────────────
      const summary = await yahooFinance.quoteSummary(ticker, {
        modules: ['financialData'],
      });
      const fd = summary.financialData ?? {};

      // ── 4. Regime return slices ────────────────────────────────────────────
      const regimeReturns = {};
      for (const [key, { start, end }] of Object.entries(REGIMES)) {
        regimeReturns[key] = sliceRegime(rawHistory, start, end);
        console.log(`     ${key}: ${regimeReturns[key].length} observations`);
      }

      // ── 5. Assemble asset profile ──────────────────────────────────────────
      assetProfiles.push({
        ticker: ticker.replace('.JK', ''),
        name:   ticker,          // full name resolved separately if needed
        sector: TICKER_SECTORS[ticker] ?? 'Other',
        meta: {
          currentPrice:   fd.currentPrice   ?? null,
          recentDailyVol,
        },
        forwardEstimates: {
          lowTarget:     fd.targetLowPrice   ?? null,
          meanTarget:    fd.targetMeanPrice  ?? null,
          highTarget:    fd.targetHighPrice  ?? null,
          totalAnalysts: fd.numberOfAnalystOpinions ?? 0,
        },
        regimeReturns,
      });

      console.log(`  ✅ ${ticker} done  (dailyVol: ${(recentDailyVol * 100).toFixed(2)}%)\n`);

    } catch (err) {
      console.error(`  ❌ ${ticker} failed:`, err.message, '\n');
    }
  }

  // ── 6. Write snapshot ──────────────────────────────────────────────────────
  const snapshot = {
    generated:    new Date().toISOString(),
    description:  'IDX Large-Cap Live Snapshot — fetched from Yahoo Finance v3',
    riskFreeRate: 0.0525, // BI 7-day reverse repo rate as of May 2026
    assets:       assetProfiles,
  };

  const outPath = join(__dirname, 'live-market-snapshot.json');
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n📦  Snapshot written → ${outPath}`);
  console.log(`    ${assetProfiles.length} assets  |  ${
    assetProfiles.map(a => a.regimeReturns.regularTimeline.length).join('+')
  } regular obs  |  ${
    assetProfiles.map(a => a.regimeReturns.stressTimeline.length).join('+')
  } stress obs\n`);
}

buildSnapshot().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
