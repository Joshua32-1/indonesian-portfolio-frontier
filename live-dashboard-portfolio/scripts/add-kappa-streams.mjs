#!/usr/bin/env node
/**
 * add-kappa-streams.mjs — ADDITIVELY add the κ>0 stream skeletons to an already-seeded
 * portfolios.json, without wiping any existing stream or its rebalance history.
 * ─────────────────────────────────────────────────────────────────────────────
 * init-portfolios-matrix.mjs refuses to run once weights are seeded (so it can't
 * migrate the live file). This one-shot fills the gap: it computes the full 300-stream
 * matrix, then PUSHES ONLY the stream objects that are missing (the κ>0 variants),
 * leaving every existing object — and its rebalances[] — untouched.
 *
 * Strictly additive + idempotent: re-running adds nothing. Refuses to run if the
 * desired set would REMOVE any existing stream (a safety check against axis drift).
 *
 * After running this, back-seed the κ>0 history for existing effective dates with
 * scripts/backseed-kappa.mjs, and future weekly rows are synthesized by merge-rebalances.mjs.
 *
 * Run: node scripts/add-kappa-streams.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildMatrix } from './lib/kappaExpand.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PORTFOLIOS = join(__dirname, '../data/portfolios.json');

if (!existsSync(PORTFOLIOS)) { console.error(`Missing ${PORTFOLIOS} — run init-portfolios-matrix.mjs first.`); process.exit(1); }

const portfolios = JSON.parse(readFileSync(PORTFOLIOS, 'utf8'));
const existing = portfolios.portfolios ?? [];
const existingIds = new Set(existing.map(p => p.id));

const desired = buildMatrix();
const desiredIds = new Set(desired.map(p => p.id));

// Safety: never remove. Every existing id must still be in the desired 300-set.
const orphans = [...existingIds].filter(id => !desiredIds.has(id));
if (orphans.length) {
  console.error(`REFUSING: ${orphans.length} existing stream(s) not in the desired matrix (axis drift):`);
  orphans.forEach(id => console.error(`  - ${id}`));
  process.exit(1);
}

const toAdd = desired.filter(p => !existingIds.has(p.id));
if (!toAdd.length) {
  console.log(`No-op: all ${desired.length} streams already present. Nothing added.`);
  process.exit(0);
}

const before = existing.length;
portfolios.portfolios = [...existing, ...toAdd];
const after = portfolios.portfolios.length;

// Assert the additive invariant: existing + added, zero removals.
if (after !== before + toAdd.length) {
  console.error(`ABORT: expected ${before} + ${toAdd.length} = ${before + toAdd.length}, got ${after}.`);
  process.exit(1);
}

writeFileSync(PORTFOLIOS, JSON.stringify(portfolios, null, 2) + '\n');
console.log(`Added ${toAdd.length} κ>0 stream skeleton(s): ${before} → ${after} (0 removals).`);
console.log('Next: node scripts/backseed-kappa.mjs to seed κ>0 history for existing effective dates.');
