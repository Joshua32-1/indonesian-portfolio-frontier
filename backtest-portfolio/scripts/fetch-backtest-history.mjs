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
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { UNIVERSE_JK } from '../../portfolio-app/data/universe.js';
import { BI_RATE_FALLBACK, BI_RATE_MIN, BI_RATE_MAX } from '../../portfolio-app/data/bi-rate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

const JAKARTA_TZ = 'Asia/Jakarta';

/** Same universe as the optimizer — single source of truth in portfolio-app/data/universe.js. */
const TICKERS = UNIVERSE_JK;

const BENCHMARK_TICKER = '^JKSE';

/** Pull history from here; Yahoo returns from each name's actual listing onward. */
const HISTORY_START = '2011-01-01';

/** The shared BI-Rate archive, owned by portfolio-app/data/refresh-bi-rate.js. */
const BI_RATE_ARCHIVE = join(__dirname, '../../portfolio-app/data/bi-rate.json');

/**
 * Resolve r_f for the backtest: env override → the bi-rate.json archive → literal.
 *
 * Reads the archive rather than scraping. One script owns it (refresh-bi-rate.js) and
 * everything else reads it, so there is exactly one place a rate can enter the monorepo.
 * `npm run fetch` bakes the series into backtest-history.json; the dev server ALSO serves
 * the archive live at /bi-rate.json, so `npm run dev` picks up a rate move without a 3 MB
 * refetch (see vite.config.js and backtestWorker.js).
 *
 * THE BACKTEST TAKES THE WHOLE DATED SERIES, not just a scalar. A walk-forward that scores
 * a 2013 rebalance at today's policy rate is quietly using information that did not exist
 * then; the engine looks up the rate in effect at each step instead. `current` is kept
 * alongside for the back-compat scalar field and the r_f stat in the UI.
 *
 * RISK_FREE_RATE=0.06 forces constant mode — for reproducing a pre-series result or a
 * sensitivity pass.
 */
function resolveRiskFree() {
  const override = process.env.RISK_FREE_RATE;
  if (override != null && override !== '') {
    const rate = Number(override);
    if (!Number.isFinite(rate) || rate < BI_RATE_MIN || rate > BI_RATE_MAX) {
      console.error(`RISK_FREE_RATE="${override}" is not a decimal in [${BI_RATE_MIN}, ${BI_RATE_MAX}] — refusing to guess.`);
      process.exit(1);
    }
    console.log(`  r_f  ${(rate * 100).toFixed(2)}% (RISK_FREE_RATE override — constant)\n`);
    return { current: rate, history: null };
  }

  try {
    const archive = JSON.parse(readFileSync(BI_RATE_ARCHIVE, 'utf8'));
    if (Number.isFinite(archive.current)) {
      const history = Array.isArray(archive.history) && archive.history.length ? archive.history : null;
      const oldest = history ? history[history.length - 1].effective : null;
      console.log(`  r_f  ${(archive.current * 100).toFixed(2)}% eff. ${archive.effective} — archive of ${history?.length ?? 0} decision(s)${oldest ? `, ${oldest} → ${archive.effective}` : ''}\n`);
      return { current: archive.current, history };
    }
    console.warn(`  r_f  archive has no usable \`current\``);
  } catch (err) {
    console.warn(`  r_f  archive unreadable (${err.message}) — run \`npm run refresh-bi-rate\` in portfolio-app`);
  }

  console.warn(`  ↓ fallback ${(BI_RATE_FALLBACK * 100).toFixed(2)}% (constant)\n`);
  return { current: BI_RATE_FALLBACK, history: null };
}

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

  // `npm run dev` runs this on every start (predev), and a full refetch is ~20 names ×
  // (daily + weekly + quoteSummary). --if-stale makes that cheap: if the file on disk already
  // covers the last completed session there are no new bars to get, so skip it. Checking the
  // bar we WOULD fetch beats a wall-clock TTL — it is exact, and it never re-fetches on a
  // weekend or a holiday when nothing new exists.
  const outPathEarly = join(__dirname, '..', 'public', 'backtest-history.json');
  if (process.argv.includes('--if-stale')) {
    try {
      const prior = JSON.parse(readFileSync(outPathEarly, 'utf8'));
      if (prior.dailyEnd >= dailyEnd && prior.weeklyEnd >= weeklyEnd && prior.tickers?.length) {
        console.log(`  ✅ up to date — ${prior.tickers.length} tickers through ${prior.dailyEnd} (last completed session). Skipping fetch.`);
        console.log(`     Force a refetch with \`npm run fetch\`.\n`);
        return;
      }
      console.log(`  ↻ stale — have ${prior.dailyEnd}, last completed session is ${dailyEnd}. Refetching.\n`);
    } catch {
      console.log('  ↻ no usable backtest-history.json — fetching.\n');
    }
  }

  const riskFree = resolveRiskFree();
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
    riskFreeRate: riskFree.current,       // scalar, back-compat + the UI stat
    riskFreeRateSeries: riskFree.history, // dated decisions; null ⇒ engine uses the scalar
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
