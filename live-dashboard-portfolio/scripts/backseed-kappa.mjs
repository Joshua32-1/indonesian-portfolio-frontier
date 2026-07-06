#!/usr/bin/env node
/**
 * backseed-kappa.mjs — ONE-SHOT: seed the κ>0 streams' history for the effective
 * dates that already exist on the κ=0 streams, so every κ line starts aligned.
 * ─────────────────────────────────────────────────────────────────────────────
 * Run ONCE, right after add-kappa-streams.mjs and BEFORE the κ streams go live.
 * For every κ=0 stream (`<base>@<configTag>`), it walks that stream's rebalances in
 * ascending effective order and, for each κ>0, appends a blended row to the matching
 * `<base>@<configTag>-k<KK>` stream:
 *   - the FIRST effective (inception) → target unchanged (κ line == κ=0 line at t0)
 *   - later effectives → blend the κ=0 target toward the κ-variant's own drifted prior
 * so each κ stream is the exact recursive blendTowardDrift of its κ=0 sibling.
 *
 * Idempotent: skips any (κ-stream, effective) already present. This CREATES history
 * on brand-new empty streams — it is not backfilling past dates into live streams, so
 * it does not violate the append-only / no-backfill invariant. Do not re-run for past
 * dates once the κ streams are live; future rows come from merge-rebalances.mjs.
 *
 * Run: node scripts/backseed-kappa.mjs [--dry-run]
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { KAPPAS, kappaTag, blendedWeightMap, priceMapFromSnapshot } from './lib/kappaExpand.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PORTFOLIOS = join(__dirname, '../data/portfolios.json');
const SNAPSHOT   = join(__dirname, '../data/live-market-snapshot.json');
const dryRun = process.argv.includes('--dry-run');

if (!existsSync(PORTFOLIOS)) { console.error(`Missing ${PORTFOLIOS}`); process.exit(1); }

const portfolios = JSON.parse(readFileSync(PORTFOLIOS, 'utf8'));
const byId = new Map(portfolios.portfolios.map(p => [p.id, p]));

let priceByTicker = new Map();
try { priceByTicker = priceMapFromSnapshot(JSON.parse(readFileSync(SNAPSHOT, 'utf8'))); }
catch { console.warn('  WARN  lean snapshot unavailable — κ>0 drift falls back to hold.'); }

const KAPPAS_POS = KAPPAS.filter(k => k > 0);
const zeroStreams = portfolios.portfolios.filter(p => (p.kappa ?? 0) === 0);

let added = 0, skipped = 0, problems = 0;

for (const z of zeroStreams) {
  const rows = [...(z.rebalances ?? [])].sort((a, b) => (a.effective < b.effective ? -1 : 1));
  for (const kappa of KAPPAS_POS) {
    const kid = `${z.id}-${kappaTag(kappa)}`;
    const kEntry = byId.get(kid);
    if (!kEntry) { console.error(`  FAIL  ${kid} — missing (run add-kappa-streams.mjs first)`); problems++; continue; }
    // Walk this κ=0 stream's rows chronologically; each κ row blends against the κ
    // variant's OWN previous row (built in earlier iterations of this same loop).
    for (const row of rows) {
      if (kEntry.rebalances.some(r => r.effective === row.effective)) { skipped++; continue; }
      const prior = [...kEntry.rebalances].filter(r => r.effective < row.effective)
        .reduce((a, b) => (!a || b.effective > a.effective ? b : a), null);
      const kWeights = blendedWeightMap(row.weights, prior?.weights ?? null, kappa, priceByTicker, prior?.effective, row.effective);
      const ksum = Object.values(kWeights).reduce((s, w) => s + w, 0);
      if (Math.abs(ksum - 1) > 0.005) { console.error(`  FAIL  ${kid} @ ${row.effective} — sum ${ksum.toFixed(4)}`); problems++; continue; }
      kEntry.rebalances.push({ effective: row.effective, weights: kWeights });
      added++;
    }
  }
}

if (problems > 0) { console.error(`\n${problems} problem(s) — aborting without writing.`); process.exit(1); }

if (dryRun) {
  console.log(`\n[dry-run] would add ${added} κ>0 row(s), ${skipped} already present. No file written.`);
} else {
  writeFileSync(PORTFOLIOS, JSON.stringify(portfolios, null, 2) + '\n');
  console.log(`\nBack-seeded +${added} κ>0 row(s), ${skipped} skipped (already present).`);
}
