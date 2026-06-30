#!/usr/bin/env node
/**
 * seed-forward-matrix.mjs — sequential, resumable seed of the forward-test matrix.
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs optimize.mjs once per methodology config (full fidelity, kappa=0 default),
 * appending that config's 6 variant streams to the dashboard portfolios.json with
 * effective = EFFECTIVE. Baselines (pert, bl-cap-t03) run FIRST so a live portfolio
 * lands in ~3h; the other 8 BL combos fill behind it (~13h total, ~80 min each).
 *
 * SEQUENTIAL (never parallel → no 8 GB OOM). RESUMABLE: a config whose streams are
 * already seeded for EFFECTIVE is skipped WITHOUT recomputing (cheap resume).
 *
 * Launch DETACHED so it survives the session closing:
 *   cd portfolio-app
 *   nohup node scripts/seed-forward-matrix.mjs > data/.seed-progress.log 2>&1 &
 *   disown
 * Resume after any interruption: relaunch the same command.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, openSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const APP_ROOT   = join(__dirname, '..');
const PORTFOLIOS = join(APP_ROOT, '..', 'live-dashboard-portfolio', 'data', 'portfolios.json');
const BT_ROOT    = join(APP_ROOT, '..', 'backtest-portfolio');

const EFFECTIVE = process.env.REBALANCE_EFFECTIVE || '2026-06-30';
// Optional fidelity override (PATHS env) — passed as --paths to optimize.mjs. Unset ⇒ config default (10k).
const PATHS_ARGS = process.env.PATHS ? ['--paths', String(process.env.PATHS)] : [];

// Baselines first (live ASAP), then the rest of the BL prior×τ grid.
const CONFIGS = [
  { tag: 'pert',         args: ['--methodology', 'pert'] },
  { tag: 'bl-cap-t03',   args: ['--methodology', 'bl', '--prior-mode', 'cap',    '--tau', '0.03'] },
  { tag: 'bl-cap-t01',   args: ['--methodology', 'bl', '--prior-mode', 'cap',    '--tau', '0.01'] },
  { tag: 'bl-cap-t10',   args: ['--methodology', 'bl', '--prior-mode', 'cap',    '--tau', '0.10'] },
  { tag: 'bl-shrunk-t01', args: ['--methodology', 'bl', '--prior-mode', 'shrunk', '--tau', '0.01'] },
  { tag: 'bl-shrunk-t03', args: ['--methodology', 'bl', '--prior-mode', 'shrunk', '--tau', '0.03'] },
  { tag: 'bl-shrunk-t10', args: ['--methodology', 'bl', '--prior-mode', 'shrunk', '--tau', '0.10'] },
  { tag: 'bl-equal-t01',  args: ['--methodology', 'bl', '--prior-mode', 'equal',  '--tau', '0.01'] },
  { tag: 'bl-equal-t03',  args: ['--methodology', 'bl', '--prior-mode', 'equal',  '--tau', '0.03'] },
  { tag: 'bl-equal-t10',  args: ['--methodology', 'bl', '--prior-mode', 'equal',  '--tau', '0.10'] },
];

const ts  = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);

/** Already seeded for EFFECTIVE? (check the config's max-sharpe stream). */
function alreadySeeded(tag) {
  if (!existsSync(PORTFOLIOS)) return false;
  const data = JSON.parse(readFileSync(PORTFOLIOS, 'utf8'));
  const entry = (data.portfolios ?? []).find(p => p.id === `max-sharpe@${tag}`);
  return !!entry?.rebalances?.some(r => r.effective === EFFECTIVE);
}

log(`=== seed forward matrix: ${CONFIGS.length} configs · effective ${EFFECTIVE} (full fidelity) ===`);
for (const cfg of CONFIGS) {
  if (alreadySeeded(cfg.tag)) { log(`SKIP  ${cfg.tag} (already seeded for ${EFFECTIVE})`); continue; }
  log(`RUN   ${cfg.tag} …`);
  const t0 = Date.now();
  const res = spawnSync('node', ['scripts/optimize.mjs', '--effective', EFFECTIVE, ...PATHS_ARGS, ...cfg.args], {
    cwd: APP_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=4096`.trim() },
  });
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  if (res.status !== 0) { log(`FAIL  ${cfg.tag} (exit ${res.status}) after ${mins}m — relaunch to retry`); continue; }
  log(`DONE  ${cfg.tag} in ${mins}m`);
}
log('=== seed complete (or all configs skipped) ===');

// CHAIN_BACKTEST=1 → auto-start the reference-backtest generation once the seed finishes
// (sequential, so no 8 GB contention). Its output goes to its own .gen-progress.log; it
// is itself resumable (skips already-done shards).
if (process.env.CHAIN_BACKTEST === '1') {
  log('CHAIN → starting backtest generation (backtest-portfolio/generate-reference-artifacts.mjs)…');
  const btLog = openSync(join(BT_ROOT, 'public', '.gen-progress.log'), 'a');
  const bt = spawnSync('node', ['scripts/generate-reference-artifacts.mjs'], {
    cwd: BT_ROOT,
    stdio: ['ignore', btLog, btLog],
    env: { ...process.env },
  });
  log(`CHAIN → backtest generator exited ${bt.status}`);
}
