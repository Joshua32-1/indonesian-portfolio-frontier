#!/usr/bin/env node
/**
 * refresh-bi-rate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js ESM script (run via: npm run refresh-bi-rate).
 *
 * Maintains data/bi-rate.json — THE archive of Bank Indonesia policy-rate decisions,
 * and the single file every app resolves r_f from. Run it daily and the archive picks
 * up a rate move the day BI announces it; the history behind it never moves.
 *
 * Assembles three inputs in increasing order of trust (see buildArchive in bi-rate.js):
 *   1. bi-rate-seed.js  — compiled history back to 2011, the part BI no longer renders
 *   2. bi-rate.json     — everything captured by earlier runs (never dropped)
 *   3. bi.go.id         — whatever BI is serving right now
 * plus an optional operator-supplied file via --import (see below).
 *
 * WRITES ONLY ON A REAL CHANGE. The `generated` timestamp alone must never dirty the
 * file, or a daily job would land ~250 no-op commits a year instead of the ~8 that match
 * BI's meeting calendar. When nothing moved the file is left byte-identical and
 * `git diff --quiet` naturally skips the commit.
 *
 * Exit code is 0 whether or not anything changed — "no change" is the common case, not an
 * error. A failed scrape is also not an error: the archive is still valid and every
 * consumer keeps resolving from it. The workflow reads the `changed` output instead.
 *
 * ── Filling gaps from another source ────────────────────────────────────────
 *   node data/refresh-bi-rate.js --import path/to/rates.json
 *   node data/refresh-bi-rate.js --import path/to/rates.csv
 *
 * JSON: an array of { effective: 'YYYY-MM-DD', rate: 0.0575 } (or a { history: [...] }
 * wrapper — a previously written bi-rate.json is itself a valid import).
 * CSV: a `date,rate` header plus rows; a rate given as 5.75 is read as 5.75%.
 * Imported rows outrank the compiled seed and are outranked by a live scrape.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  fetchBIRateSeries, buildArchive, archiveCoverage,
  BI_RATE_URL, BI_RATE_MIN, BI_RATE_MAX, SOURCE_IMPORTED, SEED_PROVENANCE, BI_RATE_SEED,
} from './bi-rate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = join(__dirname, 'bi-rate.json');

/** The backtest's earliest walk-forward step; the archive must reach at least this far back. */
const BACKTEST_CUTOFF = '2012-01-01';

const ARCHIVE_COMMENT =
  'Bank Indonesia policy-rate ARCHIVE — the single file all three apps resolve r_f from. ' +
  'Assembled by portfolio-app/data/refresh-bi-rate.js from bi-rate-seed.js (compiled history), ' +
  'the rows already here (never dropped), and a live bi.go.id scrape. Rows are newest-first and ' +
  'carry `source` (compiled | imported | bi.go.id) and `instrument` (BI_RATE_LEGACY before the ' +
  '2016-08-19 switch, BI7DRR after). NEVER hand-edit: re-run the script, or feed a file in with ' +
  '--import. Optimizer reads `current`; backtest and live tracker read `history`.';

/** Emit a step output when running under GitHub Actions; no-op locally. */
function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function finish(changed, summary) {
  console.log(`\n${summary}`);
  setOutput('changed', changed ? 'true' : 'false');
  process.exit(0);
}

/** Parse --import <path> out of argv. */
function importPathArg() {
  const i = process.argv.indexOf('--import');
  return i >= 0 ? process.argv[i + 1] : null;
}

/**
 * Read an operator-supplied history file. Accepts a bare array, a { history } wrapper, or
 * `date,rate` CSV. Percent-style rates (5.75) are normalised to decimals; anything outside
 * the sanity band is dropped rather than silently poisoning the archive.
 */
function readImport(path) {
  const text = readFileSync(path, 'utf8');
  let rows;

  if (path.toLowerCase().endsWith('.csv')) {
    rows = text.split(/\r?\n/).slice(1)
      .map(line => line.split(',').map(c => c.trim()))
      .filter(cells => cells.length >= 2 && cells[0])
      .map(([effective, rate]) => ({ effective, rate: Number(rate) }));
  } else {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : (parsed.history ?? []);
  }

  const clean = [];
  let dropped = 0;
  for (const row of rows) {
    const effective = String(row.effective ?? '').trim();
    let rate = Number(row.rate);
    if (rate > 1) rate = rate / 100; // 5.75 → 0.0575
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effective) || !Number.isFinite(rate) || rate < BI_RATE_MIN || rate > BI_RATE_MAX) {
      dropped++;
      continue;
    }
    clean.push({ effective, rate: +rate.toFixed(6), source: SOURCE_IMPORTED });
  }
  if (dropped) console.warn(`     ⚠️  ${dropped} row(s) dropped — bad date or rate outside [${BI_RATE_MIN}, ${BI_RATE_MAX}]`);
  return clean;
}

console.log('🏦  BI-Rate archive refresh\n');

const prior = existsSync(ARCHIVE) ? JSON.parse(readFileSync(ARCHIVE, 'utf8')) : null;
const priorHistory = prior?.history ?? [];
const priorCov = archiveCoverage(priorHistory);
console.log(`  archive: ${priorCov.count} decision(s)${priorCov.count ? `, ${priorCov.first} → ${priorCov.last}, current ${(priorCov.current * 100).toFixed(2)}%` : ' (empty)'}`);

// ── Optional operator-supplied rows ──────────────────────────────────────────
let imported = null;
const importPath = importPathArg();
if (importPath) {
  console.log(`  ↳ importing ${importPath} …`);
  try {
    imported = readImport(importPath);
    console.log(`     ✅ ${imported.length} usable row(s)`);
  } catch (err) {
    console.error(`     ❌ import failed: ${err.message}`);
    process.exit(1);
  }
}

// ── Live scrape ──────────────────────────────────────────────────────────────
console.log(`  ↳ scraping ${BI_RATE_URL} …`);
let scraped = null;
try {
  const live = await fetchBIRateSeries();
  scraped = live.history;
  console.log(`     ✅ ${scraped.length} decision(s), latest ${(live.current * 100).toFixed(2)}% eff. ${live.effective}`);
  console.log(`        BI renders back to ${scraped[scraped.length - 1].effective}`);
} catch (err) {
  // Not a failure of this job — the archive already holds the history and every consumer
  // keeps resolving from it. Failing here would just cry wolf on a BI backend stall.
  console.warn(`     ⚠️  scrape unavailable (${err.message}) — archive keeps its existing rows.`);
}

// ── Assemble ─────────────────────────────────────────────────────────────────
const history = buildArchive({ cached: priorHistory, imported, scraped });
const cov = archiveCoverage(history);

const next = {
  _comment: ARCHIVE_COMMENT,
  generated: new Date().toISOString(),
  source: BI_RATE_URL,
  seed: SEED_PROVENANCE,
  coverage: {
    first: cov.first,
    last: cov.last,
    decisions: cov.count,
    bySource: cov.bySource,
    maxGapDays: cov.maxGapDays,
  },
  current: history[0].rate,
  effective: history[0].effective,
  history,
};

// Compare everything EXCEPT `generated` — a timestamp bump is not a change.
const significant = (a) => JSON.stringify({ current: a.current, effective: a.effective, history: a.history });
const changed = !prior || significant(prior) !== significant(next);

console.log(`\n  coverage: ${cov.count} decision(s), ${cov.first} → ${cov.last}`);
console.log(`            by source: ${Object.entries(cov.bySource).map(([s, n]) => `${s}=${n}`).join(', ')}`);
console.log(`            longest hold: ${cov.maxGapDays}d${cov.maxGapFrom ? ` (${cov.maxGapFrom} → ${cov.maxGapTo})` : ''}`);

// The check that actually matters. A long span between decisions is NOT evidence of missing
// data — BI held 3.50% from Feb 2021 to Aug 2022 and 5.75% from Feb 2012 to Jun 2013 — so
// gap length is not a usable signal. Reaching the backtest's cutoff is: before its first row
// rateAsOf() flat-extends backwards, and the engine warns about the uncovered span.
if (!cov.first || cov.first > BACKTEST_CUTOFF) {
  console.warn(`  ⚠️  archive starts ${cov.first ?? '(empty)'}, after the backtest cutoff ${BACKTEST_CUTOFF} — steps before it are scored at the oldest known rate.`);
}

if (!changed) finish(false, `No change — BI-Rate still ${(next.current * 100).toFixed(2)}% (eff. ${next.effective}), ${cov.count} decision(s) archived.`);

const added = history.length - priorHistory.length;
const rateMoved = !!prior && prior.current !== next.current;

if (rateMoved) console.log(`\n  📈 RATE MOVED  ${(prior.current * 100).toFixed(2)}% → ${(next.current * 100).toFixed(2)}%  (eff. ${next.effective})`);
if (added > 0) console.log(`  +${added} newly archived decision(s)`);

// A scrape that contradicts a compiled seed row is the signal that the seed needs fixing —
// surface it loudly rather than letting precedence quietly paper over it.
if (scraped) {
  const byDate = new Map(BI_RATE_SEED.map(r => [r.effective, r.rate]));
  const conflicts = scraped.filter(r => byDate.has(r.effective) && byDate.get(r.effective) !== r.rate);
  if (conflicts.length) {
    console.warn(`\n  ⚠️  ${conflicts.length} compiled seed row(s) disagree with BI and were overwritten:`);
    for (const c of conflicts) console.warn(`      ${c.effective}: seed ${(byDate.get(c.effective) * 100).toFixed(2)}% → BI ${(c.rate * 100).toFixed(2)}%`);
    console.warn(`      Fix data/bi-rate-seed.js so the compiled history stops disagreeing.`);
    setOutput('seed_conflicts', String(conflicts.length));
  }
}

writeFileSync(ARCHIVE, JSON.stringify(next, null, 2) + '\n');
setOutput('current', String(next.current));
setOutput('effective', next.effective);
finish(true, `Wrote ${ARCHIVE} — current ${(next.current * 100).toFixed(2)}%, ${cov.count} decision(s), ${cov.first} → ${cov.last}.`);
