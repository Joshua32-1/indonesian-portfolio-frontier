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
 * The emit files carry only the κ=0 target streams. For each appended κ=0 stream this
 * step SYNTHESIZES the 4 κ>0 variant rows (`<base>@<configTag>-k<KK>`) for the same
 * effective date by blending the κ=0 target toward each variant's own drifted prior
 * weights — a post-hoc turnover penalty that mirrors the backtester's blendTowardDrift.
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
import { KAPPAS, kappaTag, blendedWeightMap, priceMapFromSnapshot } from './lib/kappaExpand.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PORTFOLIOS = join(__dirname, '../data/portfolios.json');
const SNAPSHOT   = join(__dirname, '../data/live-market-snapshot.json');

const files = process.argv.slice(2);
if (!files.length) { console.error('Usage: node scripts/merge-rebalances.mjs <emit.json> [more…]'); process.exit(1); }
if (!existsSync(PORTFOLIOS)) { console.error(`Missing ${PORTFOLIOS}`); process.exit(1); }

const portfolios = JSON.parse(readFileSync(PORTFOLIOS, 'utf8'));
const byId = new Map(portfolios.portfolios.map(p => [p.id, p]));

// Lean snapshot → per-ticker priceHistory for the κ-blend drift (rVec). If unavailable,
// κ>0 falls back to holding the prior (drift = 0) — still a valid, if less faithful, blend.
let priceByTicker = new Map();
try { priceByTicker = priceMapFromSnapshot(JSON.parse(readFileSync(SNAPSHOT, 'utf8'))); }
catch { console.warn('  WARN  lean snapshot unavailable — κ>0 drift falls back to hold.'); }

const KAPPAS_POS = KAPPAS.filter(k => k > 0); // [0.1, 0.25, 0.5, 0.75]

/** Most-recent stored rebalance row strictly before `effective` (or null). */
function priorRow(entry, effective) {
  const before = (entry.rebalances ?? []).filter(r => r.effective < effective);
  if (!before.length) return null;
  return before.reduce((a, b) => (a.effective > b.effective ? a : b));
}

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

    // ── κ-expansion: synthesize the κ>0 variant rows for this base@config ──
    for (const kappa of KAPPAS_POS) {
      const kid = `${id}-${kappaTag(kappa)}`;
      const kEntry = byId.get(kid);
      if (!kEntry) { console.error(`  FAIL  ${kid} — κ-variant not in portfolios.json (run add-kappa-streams.mjs)`); problems++; continue; }
      if (kEntry.rebalances.some(r => r.effective === effective)) { console.warn(`  SKIP  ${kid} — ${effective} already present`); skipped++; continue; }
      const prior = priorRow(kEntry, effective);
      const kWeights = blendedWeightMap(weights, prior?.weights ?? null, kappa, priceByTicker, prior?.effective, effective);
      const ksum = Object.values(kWeights).reduce((s, w) => s + w, 0);
      if (Math.abs(ksum - 1) > 0.005) { console.error(`  FAIL  ${kid} — blended sum ${ksum.toFixed(4)} (must be ≈1)`); problems++; continue; }
      kEntry.rebalances.push({ effective, weights: kWeights });
      added++;
    }
  }
}

if (problems > 0) { console.error(`\n${problems} problem(s) — aborting without writing.`); process.exit(1); }

portfolios.updated = latestEffective;
writeFileSync(PORTFOLIOS, JSON.stringify(portfolios, null, 2) + '\n');
console.log(`\nMerged: +${added} rebalance row(s), ${skipped} skipped (already present). updated=${latestEffective}.`);
