/**
 * api/views.mjs — GET /api/views?tickers=BBCA,BBRI[&from=2015-08-01]
 * ─────────────────────────────────────────────────────────────────────────────
 * The point-in-time analyst-target archive, READ FROM portfolio-app/data/analyst-views.json.
 *
 * Same contract as /api/rf: this route reads the committed archive and never talks to a
 * vendor. The archive is built offline by `npm run import-analyst-views` from the Bloomberg
 * exports; a serverless route cannot rebuild it and must not try.
 *
 * ── Why this route filters ───────────────────────────────────────────────────
 * The whole archive is ~1.3 MB across 86 tickers and 48k dated rows, and a workbench
 * session needs only the names in its own (editable) universe. `tickers` selects them;
 * `from` clips the series to the walk-forward window the caller will actually score, since
 * a backtest starting in 2016 never reads a 2011 target.
 *
 * The ticker filter is the big lever, the clip a useful trim: on the default 25-name
 * universe the full archive goes 1.3 MB -> 471 KB by name, then -> 371 KB clipped to 2015
 * (~70 KB over the wire gzipped).
 *
 * Both are pure subsetting: the response keeps the EXACT analyst-views.json shape, so
 * `makeViewLookup()` consumes it unchanged and the as-of semantics are identical. `coverage`
 * is recomputed for the subset rather than copied, because a stale coverage block on a
 * filtered archive would misreport what the caller is actually holding.
 *
 * ── The clip is deliberately conservative ────────────────────────────────────
 * One row BEFORE `from` is retained per ticker. An as-of lookup returns the newest row
 * <= t, so a walk beginning exactly at `from` still resolves to a real (possibly older)
 * target instead of falling off the start of the array and silently reverting to the
 * caller's fallback estimator.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sendJson, withErrorHandling, queryParam } from './_lib/http.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = join(__dirname, '..', 'portfolio-app', 'data', 'analyst-views.json');

/**
 * The archive only changes on redeploy, so it can be cached far harder than market data.
 * A day at the edge, a week of stale-while-revalidate; a deploy busts it regardless.
 */
const ARCHIVE_CACHE = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';

/** Guardrail: a caller asking for everything gets a bounded response, not 1.3 MB. */
const MAX_TICKERS = 120;

// One read per warm lambda — the file is committed and immutable between deploys.
let archivePromise = null;
function loadArchive() {
  if (!archivePromise) {
    archivePromise = readFile(ARCHIVE, 'utf8').then(JSON.parse).catch(err => {
      archivePromise = null;         // let a later request retry rather than cache the failure
      throw err;
    });
  }
  return archivePromise;
}

/** Index of the newest date <= cut, or -1. Dates are ASCENDING. */
function idxAtOrBefore(dates, cut) {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= cut) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Clip one ticker's parallel target arrays to `from`, keeping one row before it. */
function clipTargets(t, from) {
  if (!from || !t?.dates?.length) return t;
  const i = idxAtOrBefore(t.dates, from);
  const start = Math.max(0, i);          // i < 0 ⇒ nothing precedes `from`; keep everything
  if (start === 0) return t;
  return {
    dates: t.dates.slice(start),
    target: t.target.slice(start),
    price: t.price.slice(start),
  };
}

export default withErrorHandling(async (req, res) => {
  let archive;
  try {
    archive = await loadArchive();
  } catch (err) {
    // A missing archive is a deployment problem, not a client error — say so plainly
    // rather than returning an empty archive the client would read as "no coverage".
    return sendJson(res, 503, {
      error: 'archive_unavailable',
      message: 'analyst-views.json is not present in this deployment — '
        + 'run `npm run import-analyst-views` in portfolio-app and redeploy.',
      detail: err?.message ?? String(err),
    });
  }

  const raw = queryParam(req, 'tickers');
  const from = queryParam(req, 'from');
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return sendJson(res, 400, { error: 'bad_from', message: '`from` must be YYYY-MM-DD.' });
  }

  const all = Object.keys(archive.tickers ?? {});
  let wanted;
  if (raw) {
    const asked = [...new Set(
      raw.split(',').map(s => s.trim().toUpperCase().replace(/\.JK$/i, '')).filter(Boolean),
    )];
    if (asked.length > MAX_TICKERS) {
      return sendJson(res, 400, {
        error: 'too_many_tickers',
        message: `At most ${MAX_TICKERS} tickers per request; asked for ${asked.length}.`,
      });
    }
    wanted = asked.filter(t => archive.tickers[t]);
  } else {
    wanted = all;
  }

  const tickers = {};
  let rows = 0, start = null, end = null;
  const perTicker = {};
  for (const tk of wanted) {
    const rec = archive.tickers[tk];
    const targets = clipTargets(rec.targets, from);
    if (!targets?.dates?.length) continue;
    tickers[tk] = { ...rec, targets };
    rows += targets.dates.length;
    const s = targets.dates[0], e = targets.dates[targets.dates.length - 1];
    if (!start || s < start) start = s;
    if (!end || e > end) end = e;
    perTicker[tk] = {
      tier: rec.tier ?? null,
      start: s, end: e, rows: targets.dates.length,
      divEvents: rec.div?.length ?? 0,
    };
  }

  // `uncovered` is part of the contract: a caller must be able to tell "this name has no
  // analyst coverage" from "I typo'd the symbol", and both differ from an empty archive.
  const requested = raw
    ? [...new Set(raw.split(',').map(s => s.trim().toUpperCase().replace(/\.JK$/i, '')).filter(Boolean))]
    : all;
  const uncovered = requested.filter(t => !tickers[t]);

  sendJson(res, 200, {
    generated: archive.generated ?? null,
    description: archive.description ?? null,
    horizonMonths: archive.horizonMonths ?? 12,
    coverage: {
      start, end,
      tickers: Object.keys(tickers).length,
      rows,
      requested: requested.length,
      uncovered,                    // asked for, but absent from the archive
      clippedFrom: from ?? null,
      perTicker,
    },
    notes: archive.notes ?? [],
    sources: archive.sources ?? null,
    tickers,
  }, ARCHIVE_CACHE);
});
