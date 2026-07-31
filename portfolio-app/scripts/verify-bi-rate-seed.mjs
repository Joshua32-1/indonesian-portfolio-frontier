#!/usr/bin/env node
/**
 * verify-bi-rate-seed.mjs — reconcile the compiled seed against Bank Indonesia.
 * ─────────────────────────────────────────────────────────────────────────────
 * Run: node scripts/verify-bi-rate-seed.mjs        (needs network to www.bi.go.id)
 *
 * data/bi-rate-seed.js is COMPILED FROM PUBLIC RECORD, not scraped. The archive already
 * lets a live scrape outrank a compiled row, so a wrong seed row self-corrects the moment
 * BI's table covers its date — but silently. This script makes the reconciliation explicit:
 * it scrapes BI and prints a row-by-row diff so a bad compiled row can be FIXED at source
 * rather than left to be papered over on the dates BI happens to still render.
 *
 * Output classes:
 *   AGREE     seed and BI have the same rate on the same date          → nothing to do
 *   DISAGREE  same date, different rate                                → FIX bi-rate-seed.js
 *   SEED-ONLY seed has a date BI no longer renders                     → expected: this is
 *             precisely the history the seed exists to supply, and it cannot be verified
 *             from the live table. Check it against BI's press releases if it matters.
 *   BI-ONLY   BI has a date the seed lacks                             → fine: the archive
 *             picks it up on the next refresh, no seed edit needed.
 *
 * Exit 1 on any DISAGREE, so CI can gate on it. A failed scrape exits 2 (unverified, not
 * wrong) — it must not read as a passing check.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { fetchBIRateSeries, BI_RATE_URL, BI_RATE_SEED, SEED_REVIEW_FROM } from '../data/bi-rate.js';

const pct = (r) => `${(r * 100).toFixed(2)}%`;

console.log('\n🔍  BI-Rate seed verification\n');
console.log(`  seed: ${BI_RATE_SEED.length} compiled decision(s), ${BI_RATE_SEED[0].effective} → ${BI_RATE_SEED[BI_RATE_SEED.length - 1].effective}`);
console.log(`  ↳ scraping ${BI_RATE_URL} …`);

let scraped;
try {
  scraped = (await fetchBIRateSeries()).history;
} catch (err) {
  console.error(`\n❌  Scrape failed (${err.message}) — seed is UNVERIFIED, not verified-good.`);
  console.error('    Re-run somewhere with outbound access to www.bi.go.id.\n');
  process.exit(2);
}
console.log(`     ✅ ${scraped.length} decision(s), BI renders ${scraped[scraped.length - 1].effective} → ${scraped[0].effective}\n`);

const seedByDate = new Map(BI_RATE_SEED.map(r => [r.effective, r.rate]));
const biByDate = new Map(scraped.map(r => [r.effective, r.rate]));

const agree = [], disagree = [], seedOnly = [], biOnly = [];
for (const [date, rate] of seedByDate) {
  if (!biByDate.has(date)) seedOnly.push({ date, rate });
  else if (biByDate.get(date) === rate) agree.push({ date, rate });
  else disagree.push({ date, seed: rate, bi: biByDate.get(date) });
}
for (const [date, rate] of biByDate) if (!seedByDate.has(date)) biOnly.push({ date, rate });

const bydate = (a, b) => (a.date < b.date ? -1 : 1);

if (disagree.length) {
  console.log(`❌  DISAGREE — ${disagree.length} compiled row(s) contradict Bank Indonesia:`);
  for (const d of disagree.sort(bydate)) console.log(`      ${d.date}  seed ${pct(d.seed)}  ≠  BI ${pct(d.bi)}`);
  console.log('    → correct these in data/bi-rate-seed.js.\n');
}

if (biOnly.length) {
  console.log(`ℹ️   BI-ONLY — ${biOnly.length} decision(s) BI has that the seed lacks (archive picks these up automatically):`);
  for (const d of biOnly.sort(bydate)) console.log(`      ${d.date}  ${pct(d.rate)}`);
  console.log('');
}

if (seedOnly.length) {
  const review = seedOnly.filter(d => d.date >= SEED_REVIEW_FROM);
  console.log(`ℹ️   SEED-ONLY — ${seedOnly.length} compiled row(s) outside BI's rendered window (unverifiable here; this is the history the seed exists to supply).`);
  if (review.length) {
    console.log(`     ${review.length} of them are on/after SEED_REVIEW_FROM=${SEED_REVIEW_FROM} — the least certain block, worth checking by hand:`);
    for (const d of review.sort(bydate)) console.log(`      ${d.date}  ${pct(d.rate)}`);
  }
  console.log('');
}

console.log(`${disagree.length === 0 ? '✅' : '❌'}  ${agree.length} agree · ${disagree.length} disagree · ${seedOnly.length} seed-only · ${biOnly.length} BI-only\n`);
process.exit(disagree.length === 0 ? 0 : 1);
