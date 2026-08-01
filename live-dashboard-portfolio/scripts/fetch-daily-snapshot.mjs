/**
 * fetch-daily-snapshot.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches daily adjusted-close price history + daily dollar-volume for the PINNED
 * forward-test tickers and IHSG from Yahoo Finance and writes a lean snapshot to
 * data/live-market-snapshot.json. dollarVol (raw close × volume, IDR) feeds the
 * dashboard's forward liquidity-aware net-of-cost model (trailing-63 ADV), the
 * same field+semantics the backtester's history carries.
 *
 * Run: node scripts/fetch-daily-snapshot.mjs
 *       (or: npm run fetch-snapshot inside live-dashboard-portfolio/)
 *
 * Uses chart() — not historical() — because historical() throws when Yahoo
 * returns null adjclose for unsettled recent sessions (e.g. today's bar).
 * Bars with null adjclose are silently dropped so the snapshot only contains
 * finalized closes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import YahooFinance from 'yahoo-finance2';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { FORWARD_TEST_UNIVERSE_JK, toJK } from '../../portfolio-app/data/universe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Every bare ticker ever referenced across portfolios.json rebalances. Used to
 * KEEP tracking names that were dropped from the canonical universe but are still
 * held in past rebalances — without their price series the tracker can't render
 * their historical contribution. Returns [] if the file is missing/unreadable.
 */
function heldTickers() {
  const portfoliosPath = join(__dirname, '../data/portfolios.json');
  if (!existsSync(portfoliosPath)) return [];
  try {
    const data = JSON.parse(readFileSync(portfoliosPath, 'utf-8'));
    const bare = (data.portfolios ?? []).flatMap(p =>
      (p.rebalances ?? []).flatMap(r => Object.keys(r.weights ?? {})));
    return [...new Set(bare)].map(toJK);
  } catch {
    return [];
  }
}

/**
 * Fetch universe = PINNED FORWARD_TEST_UNIVERSE_JK ∪ every held ticker in
 * portfolios.json. The tracker deliberately ignores the research list
 * (UNIVERSE_JK), so editing it never adds or removes names from the live forward
 * test — see universe.js. The held-ticker union only ever ADDS names already
 * carried in past rebalances, so their price series keeps flowing.
 */
const TICKERS = [...new Set([...FORWARD_TEST_UNIVERSE_JK, ...heldTickers()])];

const BENCHMARK_TICKER = '^JKSE';

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns tomorrow's ISO date so period2 is always strictly after period1,
 * even when inception == today. Yahoo drops bars with null adj close anyway,
 * so tomorrow's bar (if unsettled) will simply not appear in the snapshot.
 */
function tomorrowISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Reads inception date from portfolios.json so period1 stays in sync
 * without hardcoding a date here.
 */
function readInception() {
  const portfoliosPath = join(__dirname, '../data/portfolios.json');
  try {
    const data = JSON.parse(readFileSync(portfoliosPath, 'utf-8'));
    return data.inception ?? '2026-06-02';
  } catch {
    return '2026-06-02';
  }
}

/**
 * Fetches daily chart quotes for one ticker via chart() and returns only
 * bars where adjclose is non-null.
 *
 * @param {string} ticker
 * @param {string} period1 — YYYY-MM-DD
 * @param {string} period2 — YYYY-MM-DD
 * @returns {Promise<{ date: string, adjClose: number, dollarVol: number }[]>}
 */
async function fetchDailyBars(ticker, period1, period2) {
  const result = await yahooFinance.chart(ticker, { period1, period2, interval: '1d' });
  const quotes = result.quotes ?? [];
  quotes.sort((a, b) => new Date(a.date) - new Date(b.date));

  return quotes
    .filter(q => q.adjclose != null || q.close != null)
    .map(q => {
      const rawClose = q.close ?? q.adjclose;          // raw (unadjusted) close for true traded value
      const volume   = q.volume ?? 0;
      return {
        date:      new Date(q.date).toISOString().slice(0, 10),
        adjClose:  +(q.adjclose ?? q.close).toFixed(4),
        dollarVol: Math.round((rawClose ?? 0) * volume), // IDR traded value; 0 when volume missing
      };
    });
}

/**
 * Serialises a bars array into { interval, dates, adjClose, dollarVol } for the snapshot.
 * dollarVol is aligned 1:1 with dates/adjClose and used for trailing-ADV net-cost estimation.
 */
function serializeBars(bars) {
  return {
    interval:  '1d',
    dates:     bars.map(b => b.date),
    adjClose:  bars.map(b => b.adjClose),
    dollarVol: bars.map(b => b.dollarVol),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function buildSnapshot() {
  const inception = readInception();
  const period1   = inception;
  // Use tomorrow so period1 != period2 even when inception == today.
  // Yahoo drops bars with null adj close, so any unsettled today-bar is filtered out.
  const period2   = tomorrowISO();

  console.log(`\nIDX Daily Snapshot  ${period1} → ${period2}\n`);

  const assets = [];

  for (const ticker of TICKERS) {
    try {
      process.stdout.write(`  ↳ ${ticker} … `);
      const bars = await fetchDailyBars(ticker, period1, period2);
      const last = bars[bars.length - 1]?.date ?? 'none';
      console.log(`${bars.length} bars  last=${last}`);

      assets.push({
        ticker:       ticker.replace('.JK', ''),
        priceHistory: serializeBars(bars),
      });
    } catch (err) {
      console.error(`  ✗ ${ticker} failed: ${err.message}`);
    }
  }

  // ── Benchmark (IHSG) ────────────────────────────────────────────────────────
  let benchmark = null;
  try {
    process.stdout.write(`  ↳ IHSG (${BENCHMARK_TICKER}) … `);
    const bars = await fetchDailyBars(BENCHMARK_TICKER, period1, period2);
    const last = bars[bars.length - 1]?.date ?? 'none';
    console.log(`${bars.length} bars  last=${last}`);

    benchmark = {
      ticker:       'IHSG',
      yahooTicker:  BENCHMARK_TICKER,
      priceHistory: serializeBars(bars),
    };
  } catch (err) {
    console.error(`  ✗ IHSG failed: ${err.message}`);
  }

  // ── Compute last common settled date across all series ─────────────────────
  const allLastDates = [
    ...(benchmark ? [benchmark.priceHistory.dates.at(-1)] : []),
    ...assets.map(a => a.priceHistory.dates.at(-1)),
  ].filter(Boolean);
  const historyEnd = allLastDates.length ? allLastDates.sort().at(-1) : period2;

  // ── Write snapshot ──────────────────────────────────────────────────────────
  const snapshot = {
    generated:   new Date().toISOString(),
    description: 'IDX Live Dashboard — daily adjusted close',
    historyRange: { start: period1, end: historyEnd, interval: '1d' },
    benchmark,
    assets,
  };

  const outPath = join(__dirname, '../data/live-market-snapshot.json');
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`\nSnapshot written → ${outPath}`);
  console.log(`  ${assets.length} assets · through ${historyEnd}\n`);
}

buildSnapshot().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
