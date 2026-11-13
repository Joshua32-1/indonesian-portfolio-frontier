/**
 * backtestWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs the live production-machinery backtest (runLiveStrategy) OFF the main thread
 * so the UI never freezes during the heavy optimizer passes. Each job streams
 * progress back.
 *
 * History reaches the worker one of two ways:
 *   • INJECTED (workbench) — the shell owns the live universe and sends
 *     { type:'init', history, dataVersion } once per universe. Jobs carry the same
 *     `dataVersion`, so a ~3 MB payload is structured-cloned once, not per job.
 *   • FETCHED (standalone) — no init arrives, so the worker loads the static
 *     /backtest-history.json itself and caches it for its lifetime, as before.
 *
 * The analyst-view archive follows the same two paths, but is loaded LAZILY: it is ~1.3 MB
 * and only a run with viewMode != 'off' needs it, so a session that never leaves Views=None
 * never fetches it.
 *
 * Protocol (main → worker):  { type:'init', history, dataVersion, views? }
 *                            { id, dataVersion?, included, frequency, lambda, kappa,
 *                              maxPositionCap, priorMode, viewMode, tau, sectorCap,
 *                              paths, optimizeMaxIter }
 * Protocol (worker → main):  { id, type: 'progress', done, total, label }
 *                            { id, type: 'result', result }
 *                            { id, type: 'error', message }
 * The `id` lets the UI ignore results from superseded jobs.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { runLiveStrategy } from './backtestEngine.js';

let injected = null;       // { history, dataVersion, views } from the shell (workbench)
let historyPromise = null; // standalone fetch, memoised
let viewsPromise = null;   // standalone analyst-archive fetch, memoised (lazy)

/**
 * Price history plus the CURRENT BI-Rate archive.
 *
 * `npm run fetch` bakes a copy of the archive into backtest-history.json, but that file is
 * ~3 MB and gets refetched rarely, while the archive is refreshed daily. So the archive is
 * overlaid here from /bi-rate.json (served live by the dev server — see vite.config.js),
 * which is what makes `npm run dev` score every step at the right r_f without a refetch.
 *
 * The overlay only ever ADDS information: the archive is union-merged and never drops rows,
 * so it is a superset of whatever the snapshot carried. If it is unreachable the baked-in
 * series is used unchanged.
 *
 * The INJECTED path does not come through here — the workbench shell carries the same
 * archive on its payload (from /api/rf), so an injected run is scored off the identical
 * dated series. Without it the engine would silently fall back to a CONSTANT r_f
 * (`riskFreeRateMode: 'constant'`) and its Sharpe would not match the standalone app's.
 */
function loadHistory() {
  if (!historyPromise) {
    historyPromise = Promise.all([
      fetch('/backtest-history.json').then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} — run \`npm run fetch\` first`);
        return r.json();
      }),
      fetch('/bi-rate.json').then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([data, archive]) => {
      if (archive?.history?.length && Number.isFinite(archive.current)) {
        return { ...data, riskFreeRate: archive.current, riskFreeRateSeries: archive.history };
      }
      return data;
    });
  }
  return historyPromise;
}

/**
 * The analyst-target archive, fetched on FIRST USE and cached for the worker's lifetime.
 *
 * Injected wins (the workbench shell owns its own copy). Standalone falls back to
 * /analyst-views.json, served live by the dev server from portfolio-app/data/ — see
 * vite.config.js. A missing archive is a HARD error rather than a silent 'off': a run
 * labelled "Analyst" that quietly carried no views would be indistinguishable in the UI
 * from one that did, which is exactly the kind of result that gets believed.
 */
function loadViews() {
  if (injected?.views) return Promise.resolve(injected.views);
  if (!viewsPromise) {
    viewsPromise = fetch('/analyst-views.json').then(r => {
      if (!r.ok) {
        throw new Error(`Analyst archive unavailable (HTTP ${r.status}) — run `
          + '`npm run import-analyst-views` in portfolio-app, or set Views to None.');
      }
      // A deployment without the archive answers the SPA rewrite with index.html, so a
      // parse failure here means "not exposed", not "corrupt".
      return r.json().catch(() => {
        throw new Error('Analyst archive response was not JSON — this deployment does not '
          + 'expose one. Set Views to None, or open the BACKTEST tab so the shell can inject it.');
      });
    }).then(v => {
      if (!v?.tickers || v.error) {
        throw new Error('Analyst archive is empty or malformed — re-run `npm run import-analyst-views`.');
      }
      return v;
    }).catch(err => {
      viewsPromise = null;          // let a later run retry rather than caching the failure
      throw err;
    });
  }
  return viewsPromise;
}

/**
 * Resolves the history a job should run against. A job tagged with a `dataVersion`
 * that doesn't match what we hold is a race — the shell primes before every run, so
 * this only happens if an init were dropped; failing loudly beats silently backtesting
 * the wrong universe.
 */
async function historyFor(dataVersion) {
  if (dataVersion) {
    if (!injected) throw new Error('Worker has no injected history for this run.');
    if (injected.dataVersion !== dataVersion) {
      throw new Error('Worker history is stale for this run — reload the universe.');
    }
    return injected.history;
  }
  return injected ? injected.history : loadHistory();
}

self.onmessage = async (e) => {
  const msg = e.data || {};

  if (msg.type === 'init') {
    injected = { history: msg.history, dataVersion: msg.dataVersion, views: msg.views ?? null };
    return;
  }

  const { id, dataVersion, included, frequency, lambda, kappa, maxPositionCap,
          priorMode, viewMode = 'off', tau = null, sectorCap, paths, optimizeMaxIter } = msg;
  try {
    // Emit progress for the slow pre-optimization phases (worker module compile on first load,
    // ~3MB history fetch/parse, then per-rebalance covariance build) so the UI doesn't look frozen
    // on "Starting…" for the 10–20 s before the first optimizer tick.
    const post = (label) => self.postMessage({ id, type: 'progress', done: 0, total: 4, label });
    post('Loading history…');
    const data = await historyFor(dataVersion);
    // 'sample' derives its views from the price history itself, so only the archive-backed
    // modes need the download.
    const views = (viewMode === 'analyst' || viewMode === 'hybrid')
      ? await (post('Loading analyst archive…'), loadViews())
      : null;
    post('Building covariances…');
    const onProgress = (done, total, label) =>
      self.postMessage({ id, type: 'progress', done, total, label });
    const result = runLiveStrategy(data, included, {
      frequency, lambda, kappa, maxPositionCap, priorMode, sectorCap, paths, optimizeMaxIter,
      viewMode, views,
      // tau only bites when a prior AND views both exist; passing it otherwise would label
      // identical runs with different configs.
      ...(tau != null && viewMode !== 'off' && priorMode !== 'none'
        ? { factorConfig: { tau } } : {}),
      onProgress,
    });
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
