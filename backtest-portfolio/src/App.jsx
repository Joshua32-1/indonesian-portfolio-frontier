import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import UniverseToggle from './components/UniverseToggle.jsx';
import EquityCurveChart from './components/EquityCurveChart.jsx';
import MetricsTable from './components/MetricsTable.jsx';
import WeightsHistoryChart from './components/WeightsHistoryChart.jsx';
import AttributionTable from './components/AttributionTable.jsx';
import StrategyBacktest from './components/StrategyBacktest.jsx';

// The walk-forward starts no earlier than this: the date Bank Indonesia replaced the legacy
// BI Rate (~6.50%) with the 7-Day Reverse Repo Rate (~5.25%). A window straddling it computes
// Sharpe against two spliced definitions of "risk-free". Mirrors DEFAULT_WINDOW_START in the
// engine — kept as a literal here because this file is UI, not math.
const WINDOW_START = '2016-08-19';

// Names listed on/before this date form the "Long history" preset. It FOLLOWS the window start
// (one year earlier, for the correlation lookback) rather than being pinned independently: a
// name listed in 2015 has all the history a 2016-start window needs, and a recent IPO would
// bind the window to a few weeks.
const LONG_HISTORY_CUTOFF = '2015-08-19';

const LAMBDAS = [0.1, 0.25, 0.35, 0.5];
const FREQ_OPTS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly (4-wk)' },
  { value: 'quarterly', label: 'Quarterly (13-wk)' },
];
// Rough wall-clock for the full-history (~19-name) universe; smaller selections are faster.
const FREQ_HINT = { weekly: '~2–3 min', monthly: '~45 s', quarterly: '~15 s' };

// Strategy display order, labels (Tail gets its λ at render), and colors.
const STRAT_META = {
  MaxSharpe: { label: 'Max-Sharpe', color: '#F472B6' },
  Tail: { label: 'Tail', color: '#8B5CF6' },
  MinVar: { label: 'Min-Var', color: '#10B981' },
  EqualWeight: { label: 'Equal-Wt', color: '#F59E0B' },
  IHSG: { label: 'IHSG', color: '#7DA8C7' },
};
const ATTR_STRATS = ['MaxSharpe', 'Tail', 'MinVar', 'EqualWeight'];

const POS_CAPS = [{ value: 1, label: 'Off' }, { value: 0.2, label: '20%' }, { value: 0.15, label: '15%' }, { value: 0.1, label: '10%' }];
const PRIORS = [{ value: 'cap', label: 'Market-cap' }, { value: 'shrunk', label: 'Shrunk 50/50' }, { value: 'equal', label: 'Equal-weight' }];

// Comparison grid: κ (rows) × prior (cols), at reduced fidelity for a faster sweep.
const GRID_KAPPAS = [0, 0.1, 0.25, 0.5];
const GRID_PATHS = 40;
const GRID_ITER = 12;
const PRIOR_LABEL = { cap: 'Market-cap', shrunk: 'Shrunk', equal: 'Equal' };

// "Reference backtest" precompute artifacts (npm run backtest / the Regenerate button), one
// file per prior. The cap run keeps the canonical filename; shrunk/equal get a -<prior> suffix.
// LOCAL AND GITIGNORED — not committed, and not built by CI. A fresh clone has none until you
// generate one, which is the point: it always reflects a universe you chose.
const REF_FILE = { cap: '/backtest-results.json', shrunk: '/backtest-results-shrunk.json', equal: '/backtest-results-equal.json' };

// Cache key includes the fidelity (paths / iters) so reduced-fidelity grid cells never collide
// with full-fidelity main-screen runs sharing the same universe/freq/λ/κ/caps/prior.
const sig = (c) =>
  `${[...c.included].sort().join(',')}|${c.frequency}|${c.lambda}|${c.kappa}|${c.maxPositionCap}|${c.priorMode}|${c.sectorCap}|${c.paths ?? 'd'}|${c.optimizeMaxIter ?? 'd'}`;
const stratLabel = (key, lambda) => (key === 'Tail' ? `Tail λ=${lambda}` : STRAT_META[key].label);

// Pivot a runLiveStrategy result into Recharts rows + series for the chosen fee mode (shared by
// the main chart and the grid cells).
function curveSeries(result, { width = 1.9, ihsgWidth = 1.4 } = {}) {
  return result.strategies.map(k => ({
    key: k, label: stratLabel(k, result.params.lambda), color: STRAT_META[k].color,
    width: k === 'IHSG' ? ihsgWidth : width, dash: k === 'IHSG' ? '5 4' : undefined,
  }));
}
function curveRows(result, feeMode) {
  return result.dates.map((d, i) => {
    const row = { date: d };
    for (const k of result.strategies) {
      const c = result.curves[k];
      if (!c) continue;
      const arr = k === 'IHSG' ? c.eq : (feeMode === 'gross' ? c.grossEq : c.netEq);
      row[k] = arr?.[i];
    }
    return row;
  });
}

export default function App() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [included, setIncluded] = useState(() => new Set());
  const [frequency, setFrequency] = useState('quarterly');
  const [lambda, setLambda] = useState(0.25);
  const [kappa, setKappa] = useState(0);
  const [posCap, setPosCap] = useState(1);        // per-name cap (1 = off)
  const [priorMode, setPriorMode] = useState('cap');
  const [sectorCap, setSectorCap] = useState(1);  // per-sector cap (1 = off)
  const [feeMode, setFeeMode] = useState('net');
  const [attrStrategy, setAttrStrategy] = useState('MaxSharpe');

  const [result, setResult] = useState(null);   // currently displayed backtest
  const [shownKey, setShownKey] = useState(null); // signature of the displayed result
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total, label }
  const [runError, setRunError] = useState(null);

  // Comparison grid (κ × prior small-multiples).
  const [gridResults, setGridResults] = useState(null); // Map cellKey → result | 'computing'
  const [gridProgress, setGridProgress] = useState(null); // { done, total }
  const [gridMeta, setGridMeta] = useState(null);         // { frequency } the grid was generated at

  // "Reference backtest" precompute (local, gitignored JSON), with a per-prior selector.
  // Distinct from the live explorer above: this is the high-fidelity, seeded, citable artifact —
  // it changes only when you rebuild it, over a universe you picked.
  const [refPrior, setRefPrior] = useState('cap');
  const refCacheRef = useRef({});            // prior → parsed JSON | null (missing) | 'loading'
  const [, setRefTick] = useState(0);        // bump to re-render when a lazy fetch lands

  // Rebuild of the frozen reference artifact, driven by the dev server (vite.config.js
  // spawns run-strategy-backtest.mjs so a UI rebuild and `npm run backtest` stay one code
  // path). null until the first attempt; `unavailable` when not running under `npm run dev`.
  const [gen, setGen] = useState(null); // { running, log[], exitCode, error, unavailable }
  const genPollRef = useRef(null);

  const workerRef = useRef(null);
  const jobRef = useRef(0);             // monotonic job id source for ALL jobs (main + grid)
  const mainJobRef = useRef(0);         // id of the latest MAIN job (for display stale-guarding)
  const gridGenRef = useRef(0);         // token for the latest grid generation
  const pendingMapRef = useRef(new Map()); // id → { kind:'main'|'grid', key, cellKey?, gen? }
  const cacheRef = useRef(new Map());   // signature → result

  // Spin up the worker once.
  useEffect(() => {
    const worker = new Worker(new URL('./backtestWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data || {};
      const p = pendingMapRef.current.get(msg.id);
      if (!p) return; // unknown / already-handled id

      if (msg.type === 'progress') {
        if (p.kind === 'main' && msg.id === mainJobRef.current) {
          setProgress({ done: msg.done, total: msg.total, label: msg.label });
        }
        return;
      }
      pendingMapRef.current.delete(msg.id);

      if (p.kind === 'main') {
        if (msg.id !== mainJobRef.current) return; // superseded by a newer main run — drop it
        if (msg.type === 'error') { setRunError(msg.message); }
        else { cacheRef.current.set(p.key, msg.result); setResult(msg.result); setShownKey(p.key); }
        setRunning(false);
        setProgress(null);
      } else if (p.kind === 'grid' && p.gen === gridGenRef.current) {
        const cell = msg.type === 'error' ? { ok: false, warnings: [msg.message] } : msg.result;
        if (msg.type === 'result') cacheRef.current.set(p.key, msg.result);
        setGridResults(prev => { const n = new Map(prev); n.set(p.cellKey, cell); return n; });
        setGridProgress(prev => (prev ? { done: prev.done + 1, total: prev.total } : prev));
      }
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  // Run (or replay from cache) a MAIN backtest for an explicit configuration object.
  const runWith = useCallback((cfg) => {
    if (cfg.included.length < 2) return;
    const key = sig(cfg);
    const cached = cacheRef.current.get(key);
    if (cached) { setResult(cached); setShownKey(key); setRunError(null); return; }
    const id = ++jobRef.current;
    mainJobRef.current = id;
    pendingMapRef.current.set(id, { kind: 'main', key });
    setRunError(null);
    setRunning(true);
    setProgress({ done: 0, total: 4, label: 'Starting…' });
    workerRef.current.postMessage({ id, ...cfg });
  }, []);

  // Load the ticker universe; default to the Long-history preset and auto-run once.
  useEffect(() => {
    fetch('/backtest-history.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} — run \`npm run fetch\` first`); return r.json(); })
      .then(d => {
        setData(d);
        const preset = d.tickers.filter(t => t.listing <= LONG_HISTORY_CUTOFF).map(t => t.ticker);
        const inc = preset.length >= 2 ? preset : d.tickers.map(t => t.ticker);
        setIncluded(new Set(inc));
        runWith({ included: inc, frequency: 'quarterly', lambda: 0.25, kappa: 0, maxPositionCap: 1, priorMode: 'cap', sectorCap: 1 });
      })
      .catch(e => setLoadError(e.message));
  }, [runWith]);

  // Lazy-load the selected prior's frozen reference artifact (cap eagerly on mount). A missing
  // file (shrunk/equal not yet generated) resolves to null → StrategyBacktest shows its own notice.
  useEffect(() => {
    if (refCacheRef.current[refPrior] !== undefined) return; // loaded or in-flight
    refCacheRef.current[refPrior] = 'loading';
    fetch(REF_FILE[refPrior])
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(j => { refCacheRef.current[refPrior] = j; setRefTick(t => t + 1); });
  }, [refPrior]);

  // Drop the cached artifact for a prior and re-read it from disk. Cache-busted because the
  // file was just overwritten at the same URL and the dev server will happily serve a 304.
  const reloadReference = useCallback((prior) => {
    refCacheRef.current[prior] = 'loading';
    setRefTick(t => t + 1);
    fetch(`${REF_FILE[prior]}?t=${Date.now()}`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(j => { refCacheRef.current[prior] = j; setRefTick(t => t + 1); });
  }, []);

  // Poll the generator while a rebuild is in flight. The sweep runs for minutes, so this is
  // a status poll rather than a stream; on a clean exit the fresh artifact is pulled in.
  useEffect(() => {
    if (!gen?.running) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const s = await (await fetch('/__reference/status')).json();
        if (stop) return;
        setGen(g => ({ ...g, running: s.running, log: s.log ?? g.log, exitCode: s.exitCode }));
        if (!s.running && s.exitCode === 0) reloadReference(refPrior);
      } catch {
        if (!stop) setGen(g => ({ ...g, running: false, error: 'Lost contact with the dev server.' }));
      }
    };
    genPollRef.current = setInterval(tick, 1500);
    tick();
    return () => { stop = true; clearInterval(genPollRef.current); };
  }, [gen?.running, refPrior, reloadReference]);

  // Rebuild the reference artifact over the CURRENT universe selection, at the currently
  // selected prior. Everything else (seed, paths, iterations, full κ-sweep, all three
  // frequencies) stays at the script's defaults so the artifact keeps its citable fidelity.
  const generateReference = async () => {
    const universe = [...included];
    if (universe.length < 2) return;
    setGen({ running: true, log: ['Starting…'], exitCode: null, error: null });
    try {
      const res = await fetch('/__reference/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ universe, prior: refPrior }),
      });
      if (res.status === 404 || res.status === 405) {
        // Not running under the dev server — the endpoint only exists in configureServer.
        setGen({ running: false, log: [], exitCode: null, unavailable: true });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setGen({ running: false, log: [], exitCode: null, error: body.error || `HTTP ${res.status}` });
      }
    } catch (e) {
      setGen({ running: false, log: [], exitCode: null, error: e.message });
    }
  };

  const cancelReference = async () => {
    try { await fetch('/__reference/cancel', { method: 'POST' }); } catch { /* the poll will notice */ }
  };

  const toggle = t => setIncluded(prev => {
    const next = new Set(prev);
    next.has(t) ? next.delete(t) : next.add(t);
    return next;
  });
  const selectAll = () => setIncluded(new Set(data.tickers.map(t => t.ticker)));
  const selectNone = () => setIncluded(new Set());
  const selectLongHistory = () =>
    setIncluded(new Set(data.tickers.filter(t => t.listing <= LONG_HISTORY_CUTOFF).map(t => t.ticker)));

  // Build the κ × prior comparison grid at the current frequency/λ/caps/universe. Cells reuse the
  // cache (instant if already run at grid fidelity); misses are posted to the single worker, which
  // runs them sequentially and streams results back tagged with this generation token.
  const generateGrid = () => {
    const inc = [...included];
    if (inc.length < 2) return;
    const gen = ++gridGenRef.current;
    const initial = new Map();
    let done = 0, total = 0;
    for (const k of GRID_KAPPAS) {
      for (const p of PRIORS) {
        total += 1;
        const cellKey = `${k}|${p.value}`;
        const cfg = {
          included: inc, frequency, lambda, kappa: k, maxPositionCap: posCap, priorMode: p.value,
          sectorCap, paths: GRID_PATHS, optimizeMaxIter: GRID_ITER,
        };
        const key = sig(cfg);
        const cached = cacheRef.current.get(key);
        if (cached) { initial.set(cellKey, cached); done += 1; }
        else {
          initial.set(cellKey, 'computing');
          const id = ++jobRef.current;
          pendingMapRef.current.set(id, { kind: 'grid', key, cellKey, gen });
          workerRef.current.postMessage({ id, ...cfg });
        }
      }
    }
    setGridMeta({ frequency });
    setGridResults(initial);
    setGridProgress({ done, total });
  };

  // Is the reference artifact still about the names you are looking at?
  //
  // It carries the universe it was built over, but nothing used to check it. That was
  // survivable while a weekly cron rebuilt it; now that it only changes when you press
  // Regenerate, an artifact can sit for months describing a universe that no longer exists —
  // silently, because every number in it still renders perfectly.
  //
  // Two different problems, and the second is the serious one:
  //   drifted  — built over a different selection than you have toggled (often deliberate)
  //   orphaned — cites names that are no longer in backtest-history.json at all, i.e.
  //              universe.js changed underneath it. Those weights can never be reproduced.
  const refUniverseDiff = useMemo(() => {
    const built = refCurrent?.ok && Array.isArray(refCurrent.universe) ? refCurrent.universe : null;
    if (!built || !data) return null;
    const builtSet = new Set(built);
    const known = new Set(data.tickers.map(t => t.ticker));
    const orphaned = built.filter(t => !known.has(t));
    const missing = [...included].filter(t => !builtSet.has(t)); // selected but not in the artifact
    const extra = built.filter(t => !included.has(t));           // in the artifact but not selected
    if (!orphaned.length && !missing.length && !extra.length) return null;
    return { orphaned, missing, extra };
  }, [refCurrent, data, included]);

  const newestIncluded = useMemo(() => {
    if (!data) return null;
    let best = null, bestDate = '0000-00-00';
    for (const t of data.tickers) {
      if (included.has(t.ticker) && t.listing > bestDate) { bestDate = t.listing; best = t.ticker; }
    }
    return best;
  }, [data, included]);

  if (loadError) return <Shell><div style={{ color: '#F87171', padding: 24 }}>⚠️ {loadError}</div></Shell>;
  if (!data) return <Shell><div style={{ color: '#5B7A95', padding: 24 }}>Loading market history…</div></Shell>;

  const currentCfg = { included: [...included], frequency, lambda, kappa, maxPositionCap: posCap, priorMode, sectorCap };
  const currentKey = sig(currentCfg);
  const stale = !running && shownKey !== null && shownKey !== currentKey;
  const onRun = () => runWith(currentCfg);
  const gridRunning = gridProgress && gridProgress.done < gridProgress.total;

  const ok = result?.ok;
  const w = ok ? result.window : null;
  const strategies = ok ? result.strategies : [];

  // Equity-curve chart rows + series for the selected fee mode (shared helpers).
  const series = ok ? curveSeries(result) : [];
  const chart = ok ? curveRows(result, feeMode) : [];
  const cols = series.map(({ key, label, color }) => ({ key, label, color }));

  const attr = ok ? result.attribution?.[attrStrategy] : null;
  const order = attr ? [...attr.rows].sort((a, b) => b.avgWeight - a.avgWeight).map(r => r.ticker) : [];

  const refCurrent = refCacheRef.current[refPrior]; // undefined | 'loading' | null | parsed JSON
  const refLoading = refCurrent === undefined || refCurrent === 'loading';
  const refProv = refCurrent && refCurrent.ok ? { gen: refCurrent.generated, ...refCurrent.params, ...refCurrent.window } : null;

  return (
    <Shell>
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
        {/* Left: universe selection */}
        <div style={panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: '#7DA8C7' }}>
              UNIVERSE ({included.size}/{data.tickers.length})
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            <button onClick={selectLongHistory} style={miniBtn} title={`Names listed on/before ${LONG_HISTORY_CUTOFF} — full window from ${WINDOW_START}`}>Long history</button>
            <button onClick={selectAll} style={miniBtn}>All</button>
            <button onClick={selectNone} style={miniBtn}>None</button>
          </div>
          <UniverseToggle
            tickers={data.tickers}
            included={included}
            newestIncluded={newestIncluded}
            onToggle={toggle} onAll={selectAll} onNone={selectNone}
            hideHeader
          />
        </div>

        {/* Right: controls + results */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Controls bar */}
          <div style={panel}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <Toggle label="Rebalance" value={frequency} setValue={setFrequency} options={FREQ_OPTS} />
              <Toggle label="Tail λ" value={lambda} setValue={setLambda}
                options={LAMBDAS.map(l => ({ value: l, label: String(l) }))} />
              <Slider label="Turnover κ" value={kappa} setValue={setKappa}
                min={0} max={0.9} step={0.05} fmt={v => (v === 0 ? 'Off' : v.toFixed(2))} />
              <Toggle label="Stock cap" value={posCap} setValue={setPosCap} options={POS_CAPS} />
              <Toggle label="Prior" value={priorMode} setValue={setPriorMode} options={PRIORS} />
              <Slider label="Sector cap" value={sectorCap} setValue={setSectorCap}
                min={0.15} max={1} step={0.05} fmt={v => (v >= 1 ? 'Off' : `${Math.round(v * 100)}%`)} />
              <Toggle label="Fees" value={feeMode} setValue={setFeeMode}
                options={[{ value: 'net', label: 'Net' }, { value: 'gross', label: 'Gross' }]} />
              <button onClick={onRun} disabled={running || included.size < 2} style={{
                ...runBtn,
                background: running ? '#1E3A5F' : stale ? '#10B981' : '#2563EB',
                color: running ? '#7DA8C7' : stale ? '#06231A' : '#E2E8F0',
                cursor: running || included.size < 2 ? 'default' : 'pointer',
                opacity: included.size < 2 ? 0.5 : 1,
              }}>
                {running ? 'Running…' : stale ? '● Run backtest' : 'Run backtest'}
              </button>
            </div>

            {!running && (
              <div style={{ fontSize: 10, color: '#5B7A95', marginTop: 8 }}>
                Heavy passes (Max-Sharpe + Tail) run off the main thread — est. <b>{FREQ_HINT[frequency]}</b> for the
                full-history universe; fewer names or a coarser frequency is faster. Min-Var, Equal-Wt &amp; IHSG are quick.
                {priorMode !== 'cap' && <> · <span style={{ color: '#A78BFA' }}>Prior shifts Max-Sharpe &amp; Tail only (Min-Var ignores returns). Equal prior + no views ⇒ Max-Sharpe ≈ Equal-Wt (the equilibrium tangency); Shrunk sits between cap-weights and equal.</span></>}
                {(posCap < 1 || sectorCap < 1) && <> · Caps reduce concentration (all strategies) but trim in-sample return.</>}
              </div>
            )}
            {running && progress && (
              <div style={{ marginTop: 10 }}>
                <div style={{ height: 6, background: '#0A1628', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.round((progress.done / progress.total) * 100)}%`, background: '#2563EB', transition: 'width .2s' }} />
                </div>
                <div style={{ fontSize: 10, color: '#7DA8C7', marginTop: 4 }}>{progress.label} ({progress.done}/{progress.total})</div>
              </div>
            )}
            {stale && !running && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#F59E0B' }}>
                ⚠️ Selection/options changed — click <b>Run backtest</b> to recompute for the current setup.
              </div>
            )}
            {runError && <div style={{ marginTop: 8, fontSize: 11, color: '#F87171' }}>⚠️ {runError}</div>}
          </div>

          {/* Window stats */}
          {ok && (
            <div style={panel}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <Stat label="WINDOW" value={`${w.start} → ${w.end}`} />
                <Stat label="REBALANCES" value={`${w.nRebalances} (${result.frequency})`} />
                <Stat label="NAMES" value={`${w.nTickers}`} />
                <Stat
                  label="WINDOW BOUND BY"
                  value={w.boundBy === 'windowStart' ? (w.windowStart ?? WINDOW_START) : w.newestListing}
                  sub={w.boundBy === 'windowStart' ? 'BI7DRR instrument switch' : 'newest listing + 1yr'}
                />
                <Stat
                  label="r_f"
                  value={`${(w.riskFreeRate * 100).toFixed(2)}%`}
                  sub={w.riskFreeRateMode === 'series'
                    ? `BI-Rate · window avg${w.riskFreeRateRange && w.riskFreeRateRange.min !== w.riskFreeRateRange.max
                        ? ` (${(w.riskFreeRateRange.min * 100).toFixed(2)}–${(w.riskFreeRateRange.max * 100).toFixed(2)}%)` : ''}`
                    : 'BI-Rate · flat'}
                />
                <Stat label="COST MODEL" value={w.costModel} />
              </div>
              {result.warnings?.length > 0 && (
                <div style={{ marginTop: 8, color: '#F59E0B', fontSize: 11 }}>
                  {result.warnings.map((m, i) => <div key={i}>⚠️ {m}</div>)}
                </div>
              )}
            </div>
          )}

          {!ok && result && (
            <div style={panel}><div style={{ color: '#F59E0B', fontSize: 12 }}>⚠️ {(result.warnings || []).join('; ')}</div></div>
          )}

          {ok && (
            <>
              {/* Equity curves */}
              <div style={panel}>
                <SectionTitle>EQUITY CURVES — {feeMode === 'net' ? 'net of costs' : 'gross (no fees)'}, indexed to 100 · κ {kappa > 0 ? 'on' : 'off'}</SectionTitle>
                <EquityCurveChart chart={chart} series={series} />
              </div>

              {/* Metrics */}
              <div style={panel}>
                <SectionTitle>PERFORMANCE &amp; RISK — net of costs ({w.costModel} model)</SectionTitle>
                <MetricsTable metrics={result.metrics} cols={cols} />
              </div>

              {/* Fee drag */}
              <div style={panel}>
                <SectionTitle>FEE DRAG — how much was paid away to trade</SectionTitle>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {ATTR_STRATS.filter(k => result.fees?.[k]).map(k => {
                    const f = result.fees[k];
                    return (
                      <div key={k} style={feeCard}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: STRAT_META[k].color }}>{stratLabel(k, result.params.lambda)}</div>
                        <div style={{ fontSize: 16, fontFamily: 'monospace', color: '#E2E8F0' }}>{f.totalFee.toFixed(1)} <span style={{ fontSize: 10, color: '#5B7A95' }}>pts</span></div>
                        <div style={{ fontSize: 10, color: '#5B7A95' }}>{(f.annualCostDrag * 100).toFixed(1)}%/yr drag · {f.annualTurnover.toFixed(1)}× turn</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10, color: '#5B7A95', marginTop: 8 }}>
                  Total fee = gross − net final index value (the equity given up to transaction costs over the window). κ {kappa > 0 ? 'on' : 'off'}.
                </div>
              </div>

              {/* Attribution */}
              {attr && (
                <div style={panel}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <SectionTitle>REBALANCE HISTORY &amp; ATTRIBUTION</SectionTitle>
                    <span>
                      {ATTR_STRATS.map(k => (
                        <button key={k} onClick={() => setAttrStrategy(k)} style={{
                          ...selBtn,
                          background: attrStrategy === k ? STRAT_META[k].color : 'transparent',
                          color: attrStrategy === k ? '#06231A' : '#7DA8C7',
                        }}>{stratLabel(k, result.params.lambda)}</button>
                      ))}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: '#5B7A95', marginBottom: 6 }}>
                    Weight path across {attr.weightRows.length} {result.frequency} rebalances (top 12 names; rest = "Other").
                  </div>
                  <WeightsHistoryChart weightRows={attr.weightRows} order={order} />
                  <div style={{ fontSize: 10, color: '#5B7A95', margin: '14px 0 4px' }}>
                    Return contribution is Carino-linked (sums to the {(attr.totalReturn * 100).toFixed(1)}% gross total);
                    risk contribution = Cov(wᵢrᵢ, r_p)/Var(r_p), realized (sums to 100%).
                  </div>
                  <AttributionTable rows={attr.rows} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Comparison grid: turnover κ (rows) × prior (cols), 4 strategies overlaid per cell. */}
      <div style={{ ...panel, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <SectionTitle>STRATEGY COMPARISON GRID — turnover κ × prior{gridMeta ? ` · ${gridMeta.frequency}` : ''}</SectionTitle>
          <button onClick={generateGrid} disabled={gridRunning || included.size < 2} style={{
            ...runBtn, marginLeft: 0,
            background: gridRunning ? '#1E3A5F' : '#2563EB',
            color: gridRunning ? '#7DA8C7' : '#E2E8F0',
            cursor: gridRunning || included.size < 2 ? 'default' : 'pointer',
            opacity: included.size < 2 ? 0.5 : 1,
          }}>{gridRunning ? `Generating… ${gridProgress.done}/${gridProgress.total}` : (gridResults ? 'Regenerate grid' : 'Generate grid')}</button>
        </div>
        <div style={{ fontSize: 10, color: '#5B7A95', marginTop: 4 }}>
          {GRID_KAPPAS.length}×{PRIORS.length} = {GRID_KAPPAS.length * PRIORS.length} cells at <b>{frequency}</b>, reduced fidelity —
          each overlays Max-Sharpe, Tail λ={lambda}, Min-Var, Equal-Wt, IHSG at the current λ/caps/universe.
          Quarterly ~1–2 min; weekly is slow. Re-running a config is instant (cached).
        </div>

        {gridRunning && (
          <div style={{ height: 6, background: '#0A1628', borderRadius: 3, overflow: 'hidden', marginTop: 8 }}>
            <div style={{ height: '100%', width: `${Math.round((gridProgress.done / gridProgress.total) * 100)}%`, background: '#2563EB', transition: 'width .2s' }} />
          </div>
        )}

        {gridResults && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${PRIORS.length}, 1fr)`, gap: 10, marginTop: 12 }}>
              {GRID_KAPPAS.flatMap(k => PRIORS.map(p => {
                const cell = gridResults.get(`${k}|${p.value}`);
                return (
                  <div key={`${k}|${p.value}`} style={miniPanel}>
                    <div style={miniTitle}>κ {k === 0 ? 'off' : k} · {PRIOR_LABEL[p.value]}</div>
                    {!cell || cell === 'computing'
                      ? <div style={miniPlaceholder}>computing…</div>
                      : !cell.ok
                        ? <div style={{ ...miniPlaceholder, color: '#F59E0B' }}>{(cell.warnings || ['failed'])[0]}</div>
                        : <EquityCurveChart chart={curveRows(cell, feeMode)} series={curveSeries(cell, { width: 1.5, ihsgWidth: 1.1 })} height={150} showLegend={false} />}
                  </div>
                );
              }))}
            </div>
            <div style={{ fontSize: 10, color: '#5B7A95', marginTop: 8 }}>
              {['MaxSharpe', 'Tail', 'MinVar', 'EqualWeight', 'IHSG'].map(key => (
                <span key={key} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'inline-block', width: 10, height: 2, background: STRAT_META[key].color, verticalAlign: 'middle', marginRight: 4 }} />
                  {key === 'Tail' ? `Tail λ=${lambda}` : STRAT_META[key].label}
                </span>
              ))}
              · {feeMode === 'net' ? 'net of costs' : 'gross'} · rows = κ, columns = prior
            </div>
          </>
        )}
      </div>

      {/* Frozen reference backtest: the committed, high-fidelity, seeded precompute. Separate from
          the live explorer above — this is the citable tearsheet, not a live recompute. */}
      <div style={{ ...panel, marginTop: 16, borderColor: '#2A2150', background: '#120E26' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <SectionTitle>REFERENCE BACKTEST — high-fidelity precompute (local, seeded, full κ-sweep)</SectionTitle>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle label="Prior" value={refPrior} setValue={setRefPrior} options={PRIORS} />
            <button
              onClick={gen?.running ? cancelReference : generateReference}
              disabled={!gen?.running && included.size < 2}
              title={gen?.running ? 'Stop the run; the artifact on disk is left alone' : `Rebuild this artifact over the ${included.size} selected names`}
              style={{
                ...runBtn, marginLeft: 0,
                background: gen?.running ? '#7F1D1D' : '#7C3AED',
                color: '#E2E8F0',
                cursor: !gen?.running && included.size < 2 ? 'default' : 'pointer',
                opacity: !gen?.running && included.size < 2 ? 0.5 : 1,
              }}
            >
              {gen?.running ? 'Cancel' : `Regenerate (${included.size})`}
            </button>
          </div>
        </div>
        <div style={{ fontSize: 10, color: '#5B7A95', marginTop: 4, lineHeight: 1.6 }}>
          The auditable tearsheet — <b>byte-reproducible</b> (fixed RNG seed), full κ-sweep across all three
          frequencies, higher-fidelity than the live explorer above. It does <b>not</b> react to the universe toggle
          as you click; it changes only when you rebuild it. Use the explorer for live "what-if"; cite this.
          {' '}<b>Regenerate</b> rebuilds it over your current selection — the dev server runs the same{' '}
          <code style={refCode}>npm run backtest</code> script, so a rebuild here and one from a terminal are
          identical at the same seed. Written to <code style={refCode}>public/{REF_FILE[refPrior].replace('/', '')}</code>,
          which is <b>gitignored and local</b> — nothing regenerates it behind your back.
        </div>
        {refProv && (
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'baseline', marginTop: 10 }}>
            <Stat label="GENERATED" value={(refProv.gen || '').slice(0, 10) || '—'} />
            <Stat label="SEED" value={refProv.seed != null ? String(refProv.seed) : '—'} sub="fixed ⇒ reproducible" />
            <Stat label="PATHS" value={refProv.paths != null ? String(refProv.paths) : '—'} sub="MC tail scenarios" />
            <Stat label="PRIOR" value={PRIOR_LABEL[refProv.priorMode] || refProv.priorMode || '—'} />
            <Stat
              label="UNIVERSE"
              value={refProv.nTickers != null ? `${refProv.nTickers} names` : '—'}
              sub={refCurrent?.universeSelection?.mode === 'explicit'
                ? 'chosen selection'
                : refCurrent?.universeSelection?.listingCutoff
                  ? `listed ≤ ${refCurrent.universeSelection.listingCutoff}`
                  : (refProv.start ? `${refProv.start} → ${refProv.end}` : undefined)}
            />
            {refProv.start && <Stat label="WINDOW" value={`${refProv.start} → ${refProv.end}`} />}
          </div>
        )}

        {refUniverseDiff && (
          <div style={{
            marginTop: 10, fontSize: 11, lineHeight: 1.7, padding: '8px 11px', borderRadius: 6,
            border: `1px solid ${refUniverseDiff.orphaned.length ? '#7F1D1D' : '#3B2E5A'}`,
            background: refUniverseDiff.orphaned.length ? '#1A0B0B' : '#150F2E',
            color: refUniverseDiff.orphaned.length ? '#FCA5A5' : '#C4B5FD',
          }}>
            {refUniverseDiff.orphaned.length > 0 && (
              <div style={{ marginBottom: refUniverseDiff.missing.length || refUniverseDiff.extra.length ? 6 : 0 }}>
                <b>⚠️ This artifact predates a universe change.</b> It was built over{' '}
                <b>{refUniverseDiff.orphaned.join(', ')}</b>, which {refUniverseDiff.orphaned.length === 1 ? 'is' : 'are'} no
                longer in <code style={refCode}>universe.js</code>. Its weights cannot be reproduced from the current
                history — <b>regenerate before citing it</b>.
              </div>
            )}
            {(refUniverseDiff.missing.length > 0 || refUniverseDiff.extra.length > 0) && (
              <div>
                Built over a different set than you have selected
                {refUniverseDiff.missing.length > 0 && <> · selected but <b>not</b> in it: {refUniverseDiff.missing.join(', ')}</>}
                {refUniverseDiff.extra.length > 0 && <> · in it but not selected: {refUniverseDiff.extra.join(', ')}</>}
                . Hit <b>Regenerate</b> to rebuild over your selection.
              </div>
            )}
          </div>
        )}

        {gen?.unavailable && (
          <div style={{ marginTop: 10, fontSize: 11, color: '#F59E0B' }}>
            ⚠️ The generator endpoint only exists under <code style={refCode}>npm run dev</code> (it spawns a Node
            process and writes into <code style={refCode}>public/</code>). From a built bundle, rebuild from a terminal:{' '}
            <code style={refCode}>UNIVERSE={[...included].join(',')} PRIOR={refPrior} npm run backtest</code>
          </div>
        )}
        {gen?.error && <div style={{ marginTop: 10, fontSize: 11, color: '#F87171' }}>⚠️ {gen.error}</div>}
        {gen && !gen.unavailable && !gen.error && (gen.running || gen.exitCode != null) && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10, color: gen.running ? '#A78BFA' : gen.exitCode === 0 ? '#10B981' : '#F87171', fontWeight: 700, marginBottom: 4 }}>
              {gen.running
                ? `Rebuilding over ${included.size} names — full sweep, minutes not seconds. Leaving this page does not stop it.`
                : gen.exitCode === 0 ? 'Rebuilt — the panel below is the new artifact.' : `Generator exited ${gen.exitCode}.`}
            </div>
            <pre style={genLog}>{(gen.log || []).join('\n').trimEnd() || '…'}</pre>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          {refLoading
            ? <div style={{ fontSize: 12, color: '#5B7A95' }}>Loading reference backtest…</div>
            : refCurrent
              ? <StrategyBacktest results={refCurrent} />
              : (
                <div style={{ fontSize: 11, color: '#F59E0B', lineHeight: 1.7 }}>
                  No artifact for the <b>{PRIOR_LABEL[refPrior]}</b> prior yet — these are local and gitignored, so a
                  fresh clone starts without one. Pick your universe on the left, then hit{' '}
                  <b>Regenerate ({included.size})</b> above. The full sweep takes minutes; from a terminal it is{' '}
                  <code style={refCode}>PRIOR={refPrior} npm run backtest</code>.
                </div>
              )}
        </div>
      </div>
    </Shell>
  );
}

function Toggle({ label, value, setValue, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {label && <span style={{ fontSize: 10, letterSpacing: 1, color: '#5B7A95', fontWeight: 700 }}>{label}</span>}
      <span style={{ display: 'inline-flex', border: '1px solid #1E3A5F', borderRadius: 6, overflow: 'hidden' }}>
        {options.map(o => (
          <button key={String(o.value)} onClick={() => setValue(o.value)} style={{
            border: 'none', cursor: 'pointer', padding: '4px 11px', fontSize: 11, fontWeight: 700,
            background: value === o.value ? '#8B5CF6' : 'transparent',
            color: value === o.value ? '#0E0820' : '#7DA8C7',
          }}>{o.label}</button>
        ))}
      </span>
    </div>
  );
}

function Slider({ label, value, setValue, min, max, step, fmt }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ fontSize: 10, letterSpacing: 1, color: '#5B7A95', fontWeight: 700 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => setValue(parseFloat(e.target.value))}
        style={{ width: 84, accentColor: '#8B5CF6', cursor: 'pointer' }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: '#7DA8C7', fontFamily: 'monospace', minWidth: 30 }}>{fmt(value)}</span>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 9, letterSpacing: 1, color: '#5B7A95', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 14, color: '#E2E8F0', fontFamily: 'monospace' }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: '#3E5A75' }}>{sub}</div>}
    </div>
  );
}

const SectionTitle = ({ children }) => (
  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: '#7DA8C7', marginBottom: 8 }}>{children}</div>
);

const panel = { background: '#0E1F35', border: '1px solid #16304D', borderRadius: 10, padding: 14 };
const refCode = { background: '#0A1628', border: '1px solid #2A2150', borderRadius: 4, padding: '1px 5px', margin: '0 2px', fontSize: 10, fontFamily: 'monospace' };
const selBtn = { border: '1px solid #1E3A5F', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: '3px 10px', marginLeft: 4 };
const miniBtn = { flex: 1, border: '1px solid #1E3A5F', borderRadius: 5, background: 'transparent', color: '#7DA8C7', fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '4px 2px' };
const runBtn = { border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 800, padding: '6px 16px', marginLeft: 'auto' };
const feeCard = { background: '#0A1A2E', border: '1px solid #122845', borderRadius: 8, padding: '8px 12px', minWidth: 120 };
const miniPanel = { background: '#0A1A2E', border: '1px solid #122845', borderRadius: 8, padding: '8px 8px 4px' };
const miniTitle = { fontSize: 10, fontWeight: 700, color: '#9FB8CC', marginBottom: 2 };
const miniPlaceholder = { height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#46617B' };
const genLog = {
  background: '#08050F', border: '1px solid #2A2150', borderRadius: 6, padding: '8px 10px', margin: 0,
  fontSize: 10, lineHeight: 1.5, color: '#9FB8CC', fontFamily: 'ui-monospace, monospace',
  maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap',
};

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#0A1628', color: '#E2E8F0', fontFamily: 'system-ui, sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 4px' }}>IDX Walk-Forward Backtest</h1>
        <p style={{ fontSize: 12, color: '#5B7A95', margin: '0 0 18px' }}>
          One live screen: the production machinery — Max-Sharpe, Tail-λ, Min-Variance, Equal-Weight — walk-forward,
          no look-ahead, net of IDX transaction costs, for <b>your</b> stock selection. Pick a universe, frequency,
          tail-λ and turnover-penalty κ, then <b>Run backtest</b> (computed off the main thread). Σ = weekly ρ ×
          theta-decay daily σ, Ledoit-Wolf shrinkage; BL-equilibrium prior. Per-strategy return/risk attribution and
          fee drag below. <b>Machinery only — no analyst views</b> (those drive the live forward-test).
        </p>
        {children}
      </div>
    </div>
  );
}
