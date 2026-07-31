/**
 * backtestWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs the live production-machinery backtest (runLiveStrategy) OFF the main thread
 * so the UI never freezes during the heavy optimizer passes. The history snapshot is
 * fetched once and cached for the worker's lifetime; each job streams progress back.
 *
 * Protocol (main → worker):  { id, included, frequency, lambda, kappa, maxPositionCap, priorMode,
 *                              sectorCap, paths, optimizeMaxIter }
 * Protocol (worker → main):  { id, type: 'progress', done, total, label }
 *                            { id, type: 'result', result }
 *                            { id, type: 'error', message }
 * The `id` lets the UI ignore results from superseded jobs.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { runLiveStrategy } from './backtestEngine.js';

let historyPromise = null;

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

self.onmessage = async (e) => {
  const { id, included, frequency, lambda, kappa, maxPositionCap, priorMode, sectorCap, paths, optimizeMaxIter } = e.data || {};
  try {
    // Emit progress for the slow pre-optimization phases (worker module compile on first load,
    // ~3MB history fetch/parse, then per-rebalance covariance build) so the UI doesn't look frozen
    // on "Starting…" for the 10–20 s before the first optimizer tick.
    const post = (label) => self.postMessage({ id, type: 'progress', done: 0, total: 4, label });
    post('Loading history…');
    const data = await loadHistory();
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
