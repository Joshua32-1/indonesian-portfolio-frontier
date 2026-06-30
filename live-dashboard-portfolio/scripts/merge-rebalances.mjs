#!/usr/bin/env node
/**
 * merge-rebalances.mjs — assemble per-config emit artifacts into portfolios.json.
 * ─────────────────────────────────────────────────────────────────────────────
 * Used by the weekly-rebalance matrix workflow: each parallel job runs
 * `optimize.mjs --emit weights-<tag>.json` (writes its config's streams WITHOUT
 * touching the shared portfolios.json), then this merge step appends every
 * stream's dated rebalance row in one shot → one PR.
 *
 * Emit-artifact shape (the contract with optimize.mjs --emit):
 *   { "effective": "YYYY-MM-DD",
 *     "streams": { "<base>@<configTag>": { "TICKER": <fraction>, ... }, ... } }
 *
 * Append-only + idempotent: a stream that already has a row for `effective` is skipped.
 * Validates each weight map sums to ~1.00 and the stream id exists in portfolios.json.
 *
 * Run: node scripts/merge-rebalances.mjs <emit1.json> [<emit2.json> …]
 *      node scripts/merge-rebalances.mjs artifacts/*.json
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PORTFOLIOS = join(__dirname, '../data/portfolios.json');

const files = process.argv.slice(2);
if (!files.length) { console.error('Usage: node scripts/merge-rebalances.mjs <emit.json> [more…]'); process.exit(1); }
if (!existsSync(PORTFOLIOS)) { console.error(`Missing ${PORTFOLIOS}`); process.exit(1); }

const portfolios = JSON.parse(readFileSync(PORTFOLIOS, 'utf8'));
const byId = new Map(portfolios.portfolios.map(p => [p.id, p]));

let added = 0, skipped = 0, problems = 0;
let latestEffective = portfolios.updated;

for (const f of files) {
  let emit;
  try { emit = JSON.parse(readFileSync(f, 'utf8')); }
  catch (e) { console.error(`  FAIL  ${f} — unreadable: ${e.message}`); problems++; continue; }
  const { effective, streams } = emit;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective || '')) { console.error(`  FAIL  ${f} — bad effective`); problems++; continue; }
  if (effective > latestEffective) latestEffective = effective;

  for (const [id, weights] of Object.entries(streams ?? {})) {
    const entry = byId.get(id);
    if (!entry) { console.error(`  FAIL  ${id} — not in portfolios.json`); problems++; continue; }
    const sum = Object.values(weights).reduce((s, w) => s + w, 0);
    if (Math.abs(sum - 1) > 0.005) { console.error(`  FAIL  ${id} — weights sum ${sum.toFixed(4)} (must be ≈1)`); problems++; continue; }
    if (entry.rebalances.some(r => r.effective === effective)) { console.warn(`  SKIP  ${id} — ${effective} already present`); skipped++; continue; }
    entry.rebalances.push({ effective, weights });
    added++;
  }
}

if (problems > 0) { console.error(`\n${problems} problem(s) — aborting without writing.`); process.exit(1); }

portfolios.updated = latestEffective;
writeFileSync(PORTFOLIOS, JSON.stringify(portfolios, null, 2) + '\n');
console.log(`\nMerged: +${added} rebalance row(s), ${skipped} skipped (already present). updated=${latestEffective}.`);
