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
  BI_RATE_FALLBACK,
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

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
