/**
 * fetch-backtest-history.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js ESM script (run via: npm run fetch).
 *
 * Fetches, for each IDX ticker, BOTH weekly and daily adjusted-close history from
 * listing → last completed session, plus the IHSG (^JKSE) weekly benchmark.
 * Writes public/backtest-history.json for the in-browser walk-forward backtest.
 *
 * Why this exists: the optimizer snapshot only stores the most recent 252 daily
 * returns. A daily-252 walk-forward needs the FULL daily series per name, which we
 * fetch here once. Toggling the universe in the UI never requires a re-fetch.
 *
 * Mirrors portfolio-app/data/fetch-snapshot.js conventions: yahoo-finance2 v3
 * .chart(), the .JK suffix, Jakarta calendar, and last-completed-bar trimming.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import YahooFinance from 'yahoo-finance2'; // v3 — capitalised class import
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

const JAKARTA_TZ = 'Asia/Jakarta';

/** Same 25-name universe as the optimizer. */
const TICKERS = [
  'BBCA.JK', 'BBRI.JK', 'BMRI.JK', 'TLKM.JK', 'ASII.JK', 'BIRD.JK',
  'INDF.JK', 'ICBP.JK', 'JSMR.JK', 'KLBF.JK', 'SIDO.JK', 'ANTM.JK',
  'BBNI.JK', 'BNGA.JK', 'CMRY.JK', 'PWON.JK', 'AMRT.JK', 'INCO.JK',
  'NCKL.JK', 'MDKA.JK', 'AADI.JK', 'UNTR.JK', 'LSIP.JK', 'CPIN.JK',
  'ISAT.JK',
];

const BENCHMARK_TICKER = '^JKSE';

/** Pull history from here; Yahoo returns from each name's actual listing onward. */
const HISTORY_START = '2011-01-01';

/** BI-Rate (decimal) used for Sharpe in the backtest. Matches fetch-snapshot fallback. */
const RISK_FREE_RATE = 0.0575;

// ── Date helpers (Jakarta calendar, UTC-safe) ─────────────────────────────────

function jakartaISO(refDate = new Date()) {
  return refDate.toLocaleDateString('en-CA', { timeZone: JAKARTA_TZ });
}

function addCalendarDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function jakartaWeekday(refDate = new Date()) {
  const label = refDate.toLocaleDateString('en-US', { timeZone: JAKARTA_TZ, weekday: 'short' });
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[label];
}

/** Last completed Friday — Yahoo's in-progress weekly bar carries null/unstable closes. */
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

// ── Fetch + serialise ─────────────────────────────────────────────────────────

/** Price history via chart(); drops unsettled (null close/adjclose) bars. Keeps raw
 * close + volume so the backtest can derive a point-in-time liquidity (dollar-volume)
 * series for its transaction-cost model. */
async function fetchPriceHistory(ticker, { period1, period2, interval }) {
  const result = await yahooFinance.chart(ticker, { period1, period2, interval });
  const quotes = result.quotes ?? [];
  quotes.sort((a, b) => new Date(a.date) - new Date(b.date));
  return quotes
    .filter(q => q?.date && (q.adjclose != null || q.close != null))
    .map(q => ({
      date: new Date(q.date).toISOString().slice(0, 10),
      adjClose: q.adjclose != null ? q.adjclose : q.close,
      close: q.close != null ? q.close : q.adjclose, // raw close for rupiah-traded value
      volume: q.volume ?? 0,
    }));
}

/**
 * { date, adjClose, close, volume }[] → compact { dates[], adjClose[] }, trimmed to
 * <= isoEnd. With { withDollarVol }, also emits dollarVol[] = raw close × volume
 * (rupiah traded per bar) — the liquidity proxy that drives per-asset trading costs.
 */
function serialize(history, isoEnd, { withDollarVol = false } = {}) {
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

/**
 * Shares outstanding via quoteSummary → defaultKeyStatistics. Current value only
 * (Yahoo exposes no history), so the backtest's cap weights assume a ~constant share
 * count — a documented approximation for the BL-equilibrium prior. null on failure.
 */
async function fetchSharesOut(ticker) {
  try {
    const r = await yahooFinance.quoteSummary(ticker, { modules: ['defaultKeyStatistics'] });
    const so = r?.defaultKeyStatistics?.sharesOutstanding;
    return Number.isFinite(so) && so > 0 ? so : null;
  } catch {
    return null;
  }
}

async function main() {
  console.log('🚀  Backtest history fetch — Yahoo Finance v3\n');

  const now = new Date();
  const weeklyEnd = lastCompletedFridayISO(now);
  const dailyEnd = lastCompletedTradingDayISO(now);
  const chartEnd = addCalendarDays(jakartaISO(now), 1); // period2 is exclusive-ish

  const tickers = [];
  for (const yahooTicker of TICKERS) {
    const bare = yahooTicker.replace('.JK', '');
    process.stdout.write(`  ↳ ${bare} … `);
    try {
      const [weeklyRaw, dailyRaw, sharesOut] = await Promise.all([
        fetchPriceHistory(yahooTicker, { period1: HISTORY_START, period2: chartEnd, interval: '1wk' }),
        fetchPriceHistory(yahooTicker, { period1: HISTORY_START, period2: chartEnd, interval: '1d' }),
        fetchSharesOut(yahooTicker),
      ]);
      const weekly = serialize(weeklyRaw, weeklyEnd);
      const daily = serialize(dailyRaw, dailyEnd, { withDollarVol: true });
      const listing = daily.dates[0] ?? weekly.dates[0] ?? null;
      tickers.push({ ticker: bare, listing, sharesOut, weekly, daily });
      console.log(`ok (listing ${listing}, ${weekly.dates.length}w / ${daily.dates.length}d, shrs ${sharesOut ?? 'n/a'})`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }

  process.stdout.write(`  ↳ IHSG benchmark (${BENCHMARK_TICKER}) … `);
  const ihsgRaw = await fetchPriceHistory(BENCHMARK_TICKER, { period1: HISTORY_START, period2: chartEnd, interval: '1wk' });
  const benchmark = { ticker: 'IHSG', yahooTicker: BENCHMARK_TICKER, weekly: serialize(ihsgRaw, weeklyEnd) };
  console.log(`ok (${benchmark.weekly.dates.length}w)`);

  const payload = {
    generated: new Date().toISOString(),
    riskFreeRate: RISK_FREE_RATE,
    weeklyEnd,
    dailyEnd,
    tickers,
    benchmark,
  };

  const outDir = join(__dirname, '..', 'public');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'backtest-history.json');
  writeFileSync(outPath, JSON.stringify(payload));
  console.log(`\n📦  Written → ${outPath}`);
  console.log(`    ${tickers.length} tickers + IHSG\n`);
}

main().catch(err => {
  console.error('\n❌  Fetch failed:', err);
  process.exit(1);
});
