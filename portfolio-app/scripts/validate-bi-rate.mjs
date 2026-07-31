#!/usr/bin/env node
/**
 * validate-bi-rate.mjs — regression suite for the shared BI-Rate module.
 * ─────────────────────────────────────────────────────────────────────────────
 * Run: node scripts/validate-bi-rate.mjs
 *
 * Covers the pure surface of data/bi-rate.js against a FIXTURE of Bank Indonesia's
 * table markup — no network, so this runs anywhere and stays deterministic.
 *
 * The load-bearing test is the look-ahead guard on rateAsOf(): the walk-forward
 * backtest asks for the rate at each historical rebalance date, and returning a
 * decision that had not happened yet would leak future information into every step.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  parseBIDate, parseBIRateTable, rateAsOf, meanRateOver, makeRateLookup, perPeriodRate,
  mergeHistory, buildArchive, archiveCoverage, instrumentFor,
  BI_RATE_FALLBACK, BI_RATE_MIN, BI_RATE_MAX, BI_RATE_SEED,
  SOURCE_COMPILED, SOURCE_IMPORTED, SOURCE_SCRAPED,
  INSTRUMENT_LEGACY, INSTRUMENT_BI7DRR, INSTRUMENT_SWITCH_DATE,
} from '../data/bi-rate.js';

let pass = 0, fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`); }
}

function near(label, actual, expected, tol = 1e-9) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       expected ≈${expected}\n       actual    ${actual}`); }
}

// Mirrors BI's EN page: newest-first rows, "%" in its own cell, mixed month spellings.
const FIXTURE = `
<table><tbody>
  <tr><td>18 June 2026</td><td class="r">5.75 %</td></tr>
  <tr><td>21 May 2026</td><td class="r">6.00 %</td></tr>
  <tr><td>16 Apr 2026</td><td class="r">6.25 %</td></tr>
  <tr><td>15 January 2026</td><td class="r">6.50 %</td></tr>
  <tr><td>32 Notamonth 2026</td><td class="r">7.00 %</td></tr>
  <tr><td>10 March 2026</td><td class="r">99.00 %</td></tr>
</tbody></table>`;

console.log('\n🧪  BI-Rate module\n');

console.log('parseBIDate');
check('full month name', parseBIDate('18 June 2026'), '2026-06-18');
check('3-letter abbreviation', parseBIDate('16 Apr 2026'), '2026-04-16');
check('single-digit day pads', parseBIDate('5 May 2026'), '2026-05-05');
check('unknown month → null', parseBIDate('32 Notamonth 2026'), null);
check('garbage → null', parseBIDate('not a date'), null);

console.log('\nparseBIRateTable');
const rows = parseBIRateTable(FIXTURE);
check('drops unparseable + out-of-band rows', rows.length, 4);
check('newest-first ordering', rows.map(r => r.effective), ['2026-06-18', '2026-05-21', '2026-04-16', '2026-01-15']);
check('rates as decimals', rows.map(r => r.rate), [0.0575, 0.06, 0.0625, 0.065]);
check('99% rejected by sanity band', rows.some(r => r.rate > 0.15), false);
check('empty html → []', parseBIRateTable('<html></html>'), []);

console.log('\nrateAsOf — LOOK-AHEAD GUARD');
check('exactly on a decision date → that rate', rateAsOf(rows, '2026-06-18'), 0.0575);
check('one day BEFORE a decision → prior rate', rateAsOf(rows, '2026-06-17'), 0.06);
check('one day after → new rate', rateAsOf(rows, '2026-06-19'), 0.0575);
check('mid-window', rateAsOf(rows, '2026-05-01'), 0.0625);
check('after the last decision', rateAsOf(rows, '2030-01-01'), 0.0575);
check('before history starts → flat back-extension', rateAsOf(rows, '2012-01-01'), 0.065);
check('empty history → null', rateAsOf([], '2026-06-18'), null);

// Order must not matter — the engine may receive the series however it was stored.
const shuffled = [rows[2], rows[0], rows[3], rows[1]];
check('unsorted input gives identical answer', rateAsOf(shuffled, '2026-06-17'), 0.06);

console.log('\nmeanRateOver');
// 2026-05-21 → 2026-06-18 is 28 days at 6.00%; 06-18 → 06-28 is 10 days at 5.75%.
near('time-weighted across one decision', meanRateOver(rows, '2026-05-21', '2026-06-28'),
  (0.06 * 28 + 0.0575 * 10) / 38, 1e-6);
near('window inside a single regime = that rate', meanRateOver(rows, '2026-06-19', '2026-06-29'), 0.0575, 1e-6);
check('empty history → null', meanRateOver([], '2026-01-01', '2026-02-01'), null);

console.log('\nmakeRateLookup');
const seriesFn = makeRateLookup(rows, BI_RATE_FALLBACK);
check('mode reported as series', seriesFn.mode, 'series');
check('delegates to rateAsOf', seriesFn('2026-06-17'), 0.06);
const constFn = makeRateLookup(null, 0.0575);
check('no series → constant mode', constFn.mode, 'constant');
check('constant ignores the date', constFn('1999-01-01'), 0.0575);
check('empty array also → constant', makeRateLookup([], 0.0575).mode, 'constant');

console.log('\nperPeriodRate');
near('weekly de-annualization compounds back', Math.pow(1 + perPeriodRate(0.0575, 52), 52) - 1, 0.0575, 1e-12);
near('daily de-annualization compounds back', Math.pow(1 + perPeriodRate(0.0575, 252), 252) - 1, 0.0575, 1e-12);
near('weekly rate is ~annual/52 to first order', perPeriodRate(0.0575, 52), 0.0575 / 52, 5e-5);
check('guards ppy=0', perPeriodRate(0.0575, 0), 0);

console.log('\ninstrumentFor — the 2016-08-19 policy-instrument change');
check('day before the switch → legacy BI Rate', instrumentFor('2016-08-18'), INSTRUMENT_LEGACY);
check('on the switch date → BI7DRR', instrumentFor(INSTRUMENT_SWITCH_DATE), INSTRUMENT_BI7DRR);
check('modern date → BI7DRR', instrumentFor('2026-06-18'), INSTRUMENT_BI7DRR);

console.log('\nmergeHistory — UNION, NEVER REPLACE');
const older = [{ effective: '2019-01-01', rate: 0.06, source: SOURCE_COMPILED }];
const newer = [{ effective: '2026-06-18', rate: 0.0575, source: SOURCE_SCRAPED }];
check('unions disjoint lists', mergeHistory(older, newer).map(r => r.effective), ['2026-06-18', '2019-01-01']);
check('a short scrape never drops archived rows', mergeHistory(older, newer).length, 2);
check('output is newest-first', mergeHistory(newer, older).map(r => r.effective), ['2026-06-18', '2019-01-01']);

// The precedence rule is what lets a live scrape correct a compiled seed row.
const compiledRow = [{ effective: '2020-01-01', rate: 0.05, source: SOURCE_COMPILED }];
const scrapedRow  = [{ effective: '2020-01-01', rate: 0.0525, source: SOURCE_SCRAPED }];
check('scrape outranks compiled, whatever the order', mergeHistory(scrapedRow, compiledRow)[0].rate, 0.0525);
check('…and the other way round too', mergeHistory(compiledRow, scrapedRow)[0].rate, 0.0525);
check('imported outranks compiled', mergeHistory([{ effective: '2020-01-01', rate: 0.055, source: SOURCE_IMPORTED }], compiledRow)[0].rate, 0.055);
check('scrape outranks imported', mergeHistory([{ effective: '2020-01-01', rate: 0.055, source: SOURCE_IMPORTED }], scrapedRow)[0].rate, 0.0525);
check('untagged rows default to compiled rank', mergeHistory([{ effective: '2020-01-01', rate: 0.04 }], scrapedRow)[0].rate, 0.0525);
check('malformed rows dropped', mergeHistory([{ effective: null, rate: 0.05 }, { effective: '2020-01-01', rate: NaN }, ...compiledRow]).length, 1);
check('missing instrument backfilled', mergeHistory([{ effective: '2013-06-13', rate: 0.06 }])[0].instrument, INSTRUMENT_LEGACY);
check('no lists → []', mergeHistory(null, undefined), []);

console.log('\nBI_RATE_SEED — the compiled history');
check('reaches at-or-before the 2012-01-01 backtest cutoff', BI_RATE_SEED[0].effective <= '2012-01-01', true);
check('strictly ascending, no duplicate dates',
  BI_RATE_SEED.every((r, i) => i === 0 || r.effective > BI_RATE_SEED[i - 1].effective), true);
check('every rate inside the sanity band',
  BI_RATE_SEED.every(r => Number.isFinite(r.rate) && r.rate >= BI_RATE_MIN && r.rate <= BI_RATE_MAX), true);
check('every date is well-formed ISO', BI_RATE_SEED.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.effective)), true);
check('instrument tag matches the switch date',
  BI_RATE_SEED.every(r => r.instrument === instrumentFor(r.effective)), true);
check('no two consecutive rows repeat a rate (a hold is not a decision)',
  BI_RATE_SEED.every((r, i) => i === 0 || r.rate !== BI_RATE_SEED[i - 1].rate), true);

console.log('\nbuildArchive');
const archive = buildArchive({ cached: null, scraped: rows });
check('seed + scrape are both present', archive.length, BI_RATE_SEED.length + rows.filter(r => !BI_RATE_SEED.some(s => s.effective === r.effective)).length);
check('newest-first', archive[0].effective >= archive[1].effective, true);
check('covers the backtest cutoff', archive[archive.length - 1].effective <= '2012-01-01', true);
check('seed alone still builds', buildArchive({}).length, BI_RATE_SEED.length);

// The reason the archive exists: a 2013 step must NOT be scored at today's rate.
check('rateAsOf over the archive gives the 2013 rate, not today\'s', rateAsOf(archive, '2013-12-31'), 0.075);
check('…and the 2021 trough', rateAsOf(archive, '2021-06-30'), 0.035);
check('…and today', rateAsOf(archive, '2026-06-18'), 0.0575);

console.log('\narchiveCoverage');
const cov = archiveCoverage(archive);
check('counts rows', cov.count, archive.length);
check('first is oldest', cov.first, archive[archive.length - 1].effective);
check('last is newest', cov.last, archive[0].effective);
check('current is the newest rate', cov.current, archive[0].rate);
check('splits by source', cov.bySource[SOURCE_COMPILED] > 0 && cov.bySource[SOURCE_SCRAPED] > 0, true);
check('empty archive → zeroed report', archiveCoverage([]).count, 0);
check('maxGapDays is positive on a real archive', cov.maxGapDays > 0, true);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
