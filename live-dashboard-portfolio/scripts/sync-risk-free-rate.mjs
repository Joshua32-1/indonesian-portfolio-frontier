#!/usr/bin/env node
/**
 * sync-risk-free-rate.mjs — push the cached BI-Rate into portfolios.json.
 * ─────────────────────────────────────────────────────────────────────────────
 * Run: node scripts/sync-risk-free-rate.mjs
 *
 * portfolios.json carries the r_f the dashboard divides by when computing Sharpe.
 * The Sunday rebalance stamps it from the optimizer emits (merge-rebalances.mjs),
 * but that leaves a rate move up to six days stale on the live tracker. The weekday
 * BI-Rate cron calls this to close that gap the same day BI announces.
 *
 * Writes ONLY when the rate actually differs, so a no-op day produces no diff and
 * no commit. Touches nothing but the two r_f fields — rebalances[] is append-only
 * and owned by merge-rebalances.mjs.
 *
 * Reads portfolio-app/data/bi-rate.json, the shared cache refreshed by
 * portfolio-app/data/refresh-bi-rate.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '../..');
const CACHE      = join(REPO_ROOT, 'portfolio-app', 'data', 'bi-rate.json');
const PORTFOLIOS = join(__dirname, '../data/portfolios.json');

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

for (const [label, p] of [['BI-Rate cache', CACHE], ['portfolios.json', PORTFOLIOS]]) {
  if (!existsSync(p)) { console.error(`Missing ${label}: ${p}`); process.exit(1); }
}

const cache = JSON.parse(readFileSync(CACHE, 'utf8'));
if (!Number.isFinite(cache.current)) { console.error('BI-Rate cache has no usable `current`.'); process.exit(1); }

const portfolios = JSON.parse(readFileSync(PORTFOLIOS, 'utf8'));
const prior = portfolios.riskFreeRate;

if (prior === cache.current && portfolios.riskFreeRateEffective === cache.effective) {
  console.log(`r_f already in sync at ${(cache.current * 100).toFixed(2)}% (eff. ${cache.effective}) — no write.`);
  setOutput('synced', 'false');
  process.exit(0);
}

portfolios.riskFreeRate = cache.current;
portfolios.riskFreeRateEffective = cache.effective;
writeFileSync(PORTFOLIOS, JSON.stringify(portfolios, null, 2) + '\n');

const from = Number.isFinite(prior) ? `${(prior * 100).toFixed(2)}%` : '(unset)';
console.log(`r_f ${from} → ${(cache.current * 100).toFixed(2)}% (eff. ${cache.effective}) — portfolios.json updated.`);
setOutput('synced', 'true');
