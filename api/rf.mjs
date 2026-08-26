/**
 * api/rf.mjs — GET /api/rf
 * ─────────────────────────────────────────────────────────────────────────────
 * The risk-free rate, READ FROM THE ARCHIVE at portfolio-app/data/bi-rate.json.
 *
 * This route deliberately does NOT scrape bi.go.id. The archive is the single file
 * every app resolves r_f from, and `refresh-bi-rate.js` (weekday cron) is the only
 * thing that talks to BI — see the header of portfolio-app/data/bi-rate.js. A public
 * serverless route scraping BI on every cache miss would both fork that contract and
 * point an unbounded number of callers at bi.go.id.
 *
 * Returns the whole `history`, not just `current`: the backtest engine scores each
 * rebalance at the rate in effect on its own date (`makeRateLookup(data.riskFreeRateSeries)`).
 * Without the series it silently falls back to a CONSTANT r_f and its Sharpe stops
 * matching the standalone app's.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { BI_RATE_FALLBACK } from '../portfolio-app/data/bi-rate.js';
import { MARKET_CACHE, sendJson, withErrorHandling } from './_lib/http.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = join(__dirname, '..', 'portfolio-app', 'data', 'bi-rate.json');

// The archive is a committed file that only changes on redeploy, so one read per
// warm lambda is plenty.
let cached = null;

export default withErrorHandling(async (_req, res) => {
  if (!cached) {
    try {
      const archive = JSON.parse(await readFile(ARCHIVE, 'utf8'));
      if (Number.isFinite(archive?.current)) {
        cached = {
          riskFreeRate: archive.current,
          effective: archive.effective ?? null,
          history: Array.isArray(archive.history) ? archive.history : [],
          source: 'archive',
          generated: archive.generated ?? null,
        };
      }
    } catch {
      // Fall through to the literal below — a missing archive must not break the app.
    }
  }

  sendJson(res, 200, cached ?? {
    riskFreeRate: BI_RATE_FALLBACK,
    effective: null,
    history: [],
    source: 'fallback',
    generated: null,
  }, MARKET_CACHE);
});
