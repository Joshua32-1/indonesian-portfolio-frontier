#!/usr/bin/env node
/**
 * generate-reference-artifacts.mjs — kill-proof sharded driver for the 3-prior
 * reference backtest.
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs each (prior × frequency) shard as its own child `node` process so memory
 * is fully released between shards (fits an 8 GB machine), SEQUENTIALLY (never
 * parallel → no OOM), fast→slow (quarterly first), and CHECKPOINT-RESUMABLE: a
 * shard whose output file already exists is skipped, so a kill just resumes.
 * After every shard it re-merges that prior's available freq shards into the
 * canonical artifact, so the UI gets incremental quarterly→monthly→weekly coverage.
 *
 * Launch DETACHED so it survives the terminal / chat session closing:
 *   cd backtest-portfolio
 *   nohup node scripts/generate-reference-artifacts.mjs > public/.gen-progress.log 2>&1 &
 *   disown
 *
 * Resume after any kill: relaunch the exact same command — done shards are skipped.
 *
 * Env (all optional): SEED=12345  PATHS=400  MAXITER=30
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const APP_ROOT   = join(__dirname, '..');
const publicDir  = join(APP_ROOT, 'public');
if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });

const PRIORS  = ['cap', 'shrunk', 'equal'];
const FREQS   = ['quarterly', 'monthly', 'weekly']; // fast → slow
const SEED    = process.env.SEED    || '12345';
const PATHS   = process.env.PATHS   || '400';
const MAXITER = process.env.MAXITER || '30';

const shardFile = (p, f) => `backtest-results-${p}-${f}.json`;
const canonFile = (p)    => (p === 'cap' ? 'backtest-results.json' : `backtest-results-${p}.json`);

const ts  = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);

function runShard(prior, freq) {
  const out = shardFile(prior, freq);
  if (existsSync(join(publicDir, out))) { log(`SKIP  ${prior}/${freq} (exists)`); return true; }
  log(`RUN   ${prior}/${freq}  seed=${SEED} paths=${PATHS} maxiter=${MAXITER} …`);
  const t0 = Date.now();
  const res = spawnSync('node', ['scripts/run-strategy-backtest.mjs'], {
    cwd: APP_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      SEED, PATHS, MAXITER, PRIOR: prior, FREQS: freq, OUTFILE: out,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=2048`.trim(),
    },
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (res.status !== 0) { log(`FAIL  ${prior}/${freq} (exit ${res.status}) after ${secs}s — will retry on next run`); return false; }
  log(`DONE  ${prior}/${freq} in ${secs}s → ${out}`);
  return true;
}

/** Merge whatever freq shards currently exist for a prior into the canonical artifact. */
function mergePrior(prior) {
  const present = FREQS.filter(f => existsSync(join(publicDir, shardFile(prior, f))));
  if (!present.length) return;
  const shards = present.map(f => JSON.parse(readFileSync(join(publicDir, shardFile(prior, f)), 'utf8')));
  const base = shards[shards.length - 1]; // shards share params/window/universe (same seed/paths/prior)
  const byFrequency = {};
  for (const j of shards) Object.assign(byFrequency, j.byFrequency);
  const frequencies = FREQS.filter(f => byFrequency[f]);

  // Recompute headline exactly as runStrategyBacktest does: monthly if present else first; best net Sharpe.
  const defaultFreq = frequencies.includes('monthly') ? 'monthly' : frequencies[0];
  let headline = null;
  if (defaultFreq && byFrequency[defaultFreq]) {
    const m = byFrequency[defaultFreq].metrics;
    let best = null;
    for (const v of base.params.variants) if (m[v.key] && (!best || m[v.key].sharpe > m[best].sharpe)) best = v.key;
    headline = { frequency: defaultFreq, feeMode: 'net', bestVariant: best, kappa: base.params.kappa };
  }
  const warnings = [...new Set(shards.flatMap(j => j.warnings || []))];

  const merged = {
    generated: base.generated,
    universe:  base.universe,
    ok: true,
    params: { ...base.params, frequencies },
    window: base.window,
    byFrequency,
    headline,
    limitations: base.limitations,
    warnings,
  };
  writeFileSync(join(publicDir, canonFile(prior)), JSON.stringify(merged));
  log(`MERGE ${prior} → ${canonFile(prior)} [${frequencies.join(',')}]`);
}

log(`=== reference artifact generation: ${PRIORS.length}×${FREQS.length} shards (seed=${SEED} paths=${PATHS}) ===`);
for (const freq of FREQS) {            // freq-major: quarterly for ALL priors first (quick wins)
  for (const prior of PRIORS) {
    runShard(prior, freq);
    mergePrior(prior);                 // re-merge after each shard → incremental UI coverage
  }
}
log('=== all shards processed ===');
for (const p of PRIORS) {
  const have = FREQS.filter(f => existsSync(join(publicDir, shardFile(p, f))));
  log(`  ${p}: [${have.join(',') || 'none'}] ${have.length === FREQS.length ? '✓ complete' : '⚠ incomplete — relaunch to finish'}`);
}
