/**
 * fetch-dividends.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds data/dividends.json — the DATED dividend record behind the total-return
 * view Q. Same contract shape as the BI-Rate and analyst-target archives: a fetch
 * script writes a committed artifact, and a pure module reads it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Q = (target - price)/price + y. Before this script, `y` came from
 * live-market-snapshot.json: ONE number per ticker, captured today, applied to
 * every historical step back to 2011 — and present for only 13 of the archive's
 * 86 names, because the snapshot only ever held the core 25. Every other name
 * silently used y = 0, which tilted μ toward the 13 that had one.
 *
 * ── The unit trap (the whole reason this file is careful) ────────────────────
 * Yahoo's dividend `amount` and its `close` are BOTH split-adjusted, so their
 * ratio is correct at any date. Bloomberg's price column in the target archive is
 * the CONTEMPORANEOUS traded price — pre-split for pre-split dates. BBCA's 2015
 * dividend is reported by Yahoo as 19.6 against a split-adjusted close of 2,645;
 * the actual payment was ~100 against a traded price of ~13,000. Both give 0.74%.
 * Dividing Yahoo's amount by Bloomberg's price would give a figure 5x too small.
 *
 * So this script stores each dividend as a DIMENSIONLESS YIELD FRACTION measured
 * at its own ex-date, y_s = amount_s / close_s, entirely inside Yahoo's space.
 * Being scale-free, it composes with a Bloomberg-derived upside without ever
 * mixing the two price conventions.
 *
 * A trailing-twelve-month yield is then the sum of y_s over the past year:
 *   y(t) = SUM over ex-dates s in (t - 365d, t] of amount_s / close_s
 * i.e. each dividend measured against the price prevailing when it was actually
 * paid — the yield an investor genuinely earned — rather than (SUM amount)/price(t),
 * which silently rescales old payments by a newer price.
 *
 * Mirrors the other fetch scripts' Yahoo conventions (yahoo-finance2 v3 .chart(),
 * the .JK suffix) rather than importing them — see CLAUDE.md rule 4c.
 *
 * Usage:  node scripts/fetch-dividends.mjs [--out <path>]
 *         TICKERS=BBCA,BBRI node scripts/fetch-dividends.mjs   # subset, for spot checks
 * ─────────────────────────────────────────────────────────────────────────────
 */

import YahooFinance from 'yahoo-finance2'; // v3 — capitalised class import
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ARCHIVE_UNIVERSE_JK, toBare, toJK, tierOf } from '../data/universe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const outPath = arg('--out', join(dataDir, 'dividends.json'));

/**
 * Match the target archive's reach: every tier it spans, INCLUDING 'historical' (names that
 * have left the index). A point-in-time backtest holds those names in the years they were
 * constituents, so their dividends are part of the return it books.
 */
const TICKERS = process.env.TICKERS
  ? process.env.TICKERS.split(',').map(s => s.trim()).filter(Boolean).map(toJK)
  : ARCHIVE_UNIVERSE_JK;

/** Far enough back to cover the target archive's 2011-08 start. */
const HISTORY_START = '2010-01-01';

const iso = d => new Date(d).toISOString().slice(0, 10);
const round = (v, dp) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

/**
 * Nearest daily close AT OR BEFORE an ex-date. Yahoo's ex-date is a trading day in
 * almost every case, but a suspended or holiday-shifted name can land off-grid, and
 * dividing by the WRONG day's price is exactly the kind of silent error this file
 * exists to avoid. Falls back to the first close after, then gives up (event dropped).
 */
function closeAtOrBefore(dates, closes, target) {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans >= 0 && closes[ans] > 0) return { price: closes[ans], date: dates[ans] };
  const fwd = dates.findIndex((d, i) => d >= target && closes[i] > 0);
  return fwd >= 0 ? { price: closes[fwd], date: dates[fwd] } : null;
}

async function main() {
  console.log('💰  Dividend history fetch — Yahoo Finance v3');
  console.log(`    ${TICKERS.length} ticker(s) from ${HISTORY_START}\n`);

  const end = iso(Date.now() + 86400000); // period2 is exclusive-ish
  const tickers = {};
  const failed = [];
  let totalEvents = 0;

  for (const yahooTicker of TICKERS) {
    const bare = toBare(yahooTicker);
    process.stdout.write(`  ↳ ${bare} … `);
    try {
      const r = await yahooFinance.chart(yahooTicker, {
        period1: HISTORY_START, period2: end, interval: '1d', events: 'div',
      });

      // Split-adjusted daily closes — the denominator, in the SAME space as `amount`.
      const dates = [], closes = [];
      for (const q of r.quotes ?? []) {
        if (!q?.date || q.close == null || !(q.close > 0)) continue;
        dates.push(iso(q.date));
        closes.push(q.close);
      }

      const events = [];
      let skipped = 0;
      for (const d of r.events?.dividends ?? []) {
        if (!(d?.amount > 0) || !d.date) { skipped++; continue; }
        const exDate = iso(d.date);
        const hit = closeAtOrBefore(dates, closes, exDate);
        if (!hit) { skipped++; continue; }
        const y = d.amount / hit.price;
        // A single payment above 40% of price is a data error (a capital return or a
        // mis-scaled amount), not a dividend. Drop it rather than let it poison Q.
        if (!(y > 0) || y > 0.4) { skipped++; continue; }
        events.push({
          d: exDate,
          amount: round(d.amount, 4),
          price: round(hit.price, 2),
          y: round(y, 6),
        });
      }
      events.sort((a, b) => a.d.localeCompare(b.d)); // ASCENDING — lookups binary-search

      tickers[bare] = { tier: tierOf(bare) ?? 'untagged', events };
      totalEvents += events.length;
      const span = events.length ? `${events[0].d} → ${events[events.length - 1].d}` : 'none';
      console.log(`ok (${String(events.length).padStart(3)} events, ${span}`
        + `${skipped ? `, ${skipped} skipped` : ''})`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      failed.push(bare);
    }
  }

  const payload = {
    generated: new Date().toISOString(),
    description:
      'DATED dividend record per ticker. Each event stores the dividend as a dimensionless '
      + 'YIELD FRACTION measured at its own ex-date (y = amount / close on that date), with both '
      + 'figures taken from Yahoo\'s split-adjusted series so the ratio is correct at any point in '
      + 'history. A trailing-twelve-month yield is the SUM of y over ex-dates in (t-365d, t]. '
      + 'Being scale-free, y composes with a Bloomberg-derived upside without mixing the two price '
      + 'conventions (Bloomberg quotes the contemporaneous traded price; Yahoo back-adjusts for '
      + 'splits). Read via data/dividends.js — do not hand-edit.',
    windowDays: 365,
    source: 'Yahoo Finance v3 chart(events: "div"), split-adjusted amounts and closes',
    coverage: {
      tickers: Object.keys(tickers).length,
      events: totalEvents,
      withEvents: Object.values(tickers).filter(t => t.events.length).length,
      failed,
    },
    tickers,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 0) + '\n');

  const kb = (JSON.stringify(payload).length / 1024).toFixed(0);
  console.log(`\n📦  ${outPath}  (${kb} KB)`);
  console.log(`    ${payload.coverage.tickers} tickers · ${totalEvents} dividend events · `
    + `${payload.coverage.withEvents} names pay a dividend`);
  if (failed.length) console.log(`    ⚠️  failed: ${failed.join(', ')}`);
}

main().catch(err => {
  console.error('\n❌  Dividend fetch failed:', err);
  process.exit(1);
});
