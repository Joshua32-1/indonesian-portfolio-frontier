#!/usr/bin/env node
/**
 * sync-risk-free-rate.mjs — push the BI-Rate archive into portfolios.json.
 * ─────────────────────────────────────────────────────────────────────────────
 * Run: node scripts/sync-risk-free-rate.mjs
 *
 * THE LIVE FORWARD TEST IS THE ONE CONSUMER THAT NEEDS PUSHING TO. The optimizer and
 * the backtest both READ portfolio-app/data/bi-rate.json directly at `npm run dev`, so
 * they are current by construction and need no job. The tracker is different: it is
 * deployed to Vercel and builds from committed data, so a rate move only reaches it if
 * something writes it in. That is this script, called by the weekday BI-Rate cron.
 *
 * Writes BOTH:
 *   riskFreeRate        today's rate — the headline, and the pre-archive fallback
 *   riskFreeRateSeries  the dated archive, so each daily row is scored at the rate in
 *                       effect ON that day. Without it, the next BI move would silently
 *                       re-score every day the forward test has already recorded.
 *
 * Writes ONLY when something actually differs, so a no-op day produces no diff and no
 * commit. Touches nothing but the r_f fields — rebalances[] is append-only and owned by
 * merge-rebalances.mjs.
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

const archive = JSON.parse(readFileSync(CACHE, 'utf8'));
if (!Number.isFinite(archive.current)) { console.error('BI-Rate archive has no usable `current`.'); process.exit(1); }

// Carry only the fields the dashboard reads. `instrument`/`source` are provenance for the
// archive itself and would inflate a file the browser downloads on every page load.
const series = (archive.history ?? [])
  .filter(r => r && typeof r.effective === 'string' && Number.isFinite(r.rate))
  .map(({ effective, rate }) => ({ effective, rate }));

const portfolios = JSON.parse(readFileSync(PORTFOLIOS, 'utf8'));
const prior = portfolios.riskFreeRate;

const same = prior === archive.current
  && portfolios.riskFreeRateEffective === archive.effective
  && JSON.stringify(portfolios.riskFreeRateSeries ?? null) === JSON.stringify(series.length ? series : null);

if (same) {
  console.log(`r_f already in sync at ${(archive.current * 100).toFixed(2)}% (eff. ${archive.effective}), ${series.length} decision(s) — no write.`);
  setOutput('synced', 'false');
  process.exit(0);
}

portfolios.riskFreeRate = archive.current;
portfolios.riskFreeRateEffective = archive.effective;
portfolios.riskFreeRateSeries = series.length ? series : null;
writeFileSync(PORTFOLIOS, JSON.stringify(portfolios, null, 2) + '\n');

const from = Number.isFinite(prior) ? `${(prior * 100).toFixed(2)}%` : '(unset)';
console.log(`r_f ${from} → ${(archive.current * 100).toFixed(2)}% (eff. ${archive.effective}), ${series.length} dated decision(s) — portfolios.json updated.`);
setOutput('synced', 'true');
