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
 * Protocol (main → worker):  { type:'init', history, dataVersion }
 *                            { id, dataVersion?, included, frequency, lambda, kappa,
 *                              maxPositionCap, priorMode, sectorCap, paths, optimizeMaxIter }
 * Protocol (worker → main):  { id, type: 'progress', done, total, label }
 *                            { id, type: 'result', result }
 *                            { id, type: 'error', message }
 * The `id` lets the UI ignore results from superseded jobs.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { runLiveStrategy } from './backtestEngine.js';

let injected = null;       // { history, dataVersion } from the shell (workbench)
let historyPromise = null; // standalone fetch, memoised

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
    injected = { history: msg.history, dataVersion: msg.dataVersion };
    return;
  }

  const { id, dataVersion, included, frequency, lambda, kappa, maxPositionCap,
          priorMode, sectorCap, paths, optimizeMaxIter } = msg;
  try {
    // Emit progress for the slow pre-optimization phases (worker module compile on first load,
    // ~3MB history fetch/parse, then per-rebalance covariance build) so the UI doesn't look frozen
    // on "Starting…" for the 10–20 s before the first optimizer tick.
    const post = (label) => self.postMessage({ id, type: 'progress', done: 0, total: 4, label });
    post('Loading history…');
    const data = await historyFor(dataVersion);
    post('Building covariances…');
    const onProgress = (done, total, label) =>
      self.postMessage({ id, type: 'progress', done, total, label });
    const result = runLiveStrategy(data, included, {
      frequency, lambda, kappa, maxPositionCap, priorMode, sectorCap, paths, optimizeMaxIter, onProgress,
    });
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
