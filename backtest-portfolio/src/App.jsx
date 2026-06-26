import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import UniverseToggle from './components/UniverseToggle.jsx';
import EquityCurveChart from './components/EquityCurveChart.jsx';
import MetricsTable from './components/MetricsTable.jsx';
import WeightsHistoryChart from './components/WeightsHistoryChart.jsx';
import AttributionTable from './components/AttributionTable.jsx';

// Names listed on/before this date form the "Long history" preset — recent IPOs bind the
// walk-forward window to a few weeks, so this preset gives the machinery a meaningful window.
const LONG_HISTORY_CUTOFF = '2012-01-01';

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

const sig = (c) =>
  `${[...c.included].sort().join(',')}|${c.frequency}|${c.lambda}|${c.kappa}|${c.maxPositionCap}|${c.priorMode}|${c.sectorCap}`;
const stratLabel = (key, lambda) => (key === 'Tail' ? `Tail λ=${lambda}` : STRAT_META[key].label);

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

  const workerRef = useRef(null);
  const jobRef = useRef(0);            // monotonic job id; results from older ids are ignored
  const pendingRef = useRef(null);     // { id, key } of the in-flight job
  const cacheRef = useRef(new Map());  // signature → result

  // Spin up the worker once.
  useEffect(() => {
    const worker = new Worker(new URL('./backtestWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.id !== jobRef.current) return; // stale job — ignore
      if (msg.type === 'progress') {
        setProgress({ done: msg.done, total: msg.total, label: msg.label });
      } else if (msg.type === 'result') {
        const key = pendingRef.current?.key;
        if (key) cacheRef.current.set(key, msg.result);
        setResult(msg.result);
        setShownKey(key);
        setRunning(false);
        setProgress(null);
      } else if (msg.type === 'error') {
        setRunError(msg.message);
        setRunning(false);
        setProgress(null);
      }
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  // Run (or replay from cache) a backtest for an explicit configuration object.
  const runWith = useCallback((cfg) => {
    if (cfg.included.length < 2) return;
    const key = sig(cfg);
    const cached = cacheRef.current.get(key);
    if (cached) { setResult(cached); setShownKey(key); setRunError(null); return; }
    const id = ++jobRef.current;
    pendingRef.current = { id, key };
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

  const toggle = t => setIncluded(prev => {
    const next = new Set(prev);
    next.has(t) ? next.delete(t) : next.add(t);
    return next;
  });
  const selectAll = () => setIncluded(new Set(data.tickers.map(t => t.ticker)));
  const selectNone = () => setIncluded(new Set());
  const selectLongHistory = () =>
    setIncluded(new Set(data.tickers.filter(t => t.listing <= LONG_HISTORY_CUTOFF).map(t => t.ticker)));

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

  const ok = result?.ok;
  const w = ok ? result.window : null;
  const strategies = ok ? result.strategies : [];

  // Equity-curve chart rows + series for the selected fee mode.
  const series = strategies.map(k => ({
    key: k, label: stratLabel(k, result.params.lambda), color: STRAT_META[k].color,
    width: k === 'IHSG' ? 1.4 : 1.9, dash: k === 'IHSG' ? '5 4' : undefined,
  }));
  const chart = ok ? result.dates.map((d, i) => {
    const row = { date: d };
    for (const k of strategies) {
      const c = result.curves[k];
      if (!c) continue;
      const arr = k === 'IHSG' ? c.eq : (feeMode === 'gross' ? c.grossEq : c.netEq);
      row[k] = arr?.[i];
    }
    return row;
  }) : [];
  const cols = series.map(({ key, label, color }) => ({ key, label, color }));

  const attr = ok ? result.attribution?.[attrStrategy] : null;
  const order = attr ? [...attr.rows].sort((a, b) => b.avgWeight - a.avgWeight).map(r => r.ticker) : [];

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
            <button onClick={selectLongHistory} style={miniBtn} title="Names listed on/before 2012 — longest window">Long history</button>
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
                {priorMode === 'equal' && <> · <span style={{ color: '#A78BFA' }}>Equal prior + no views ⇒ Max-Sharpe ≈ Equal-Wt.</span></>}
                {priorMode !== 'cap' && <> · Prior moves Max-Sharpe &amp; Tail only — Min-Var ignores returns.</>}
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
                <Stat label="WINDOW BOUND BY" value={w.newestListing} sub="newest listing + 1yr" />
                <Stat label="r_f" value={`${(w.riskFreeRate * 100).toFixed(2)}%`} sub="BI-Rate" />
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
const selBtn = { border: '1px solid #1E3A5F', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: '3px 10px', marginLeft: 4 };
const miniBtn = { flex: 1, border: '1px solid #1E3A5F', borderRadius: 5, background: 'transparent', color: '#7DA8C7', fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '4px 2px' };
const runBtn = { border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 800, padding: '6px 16px', marginLeft: 'auto' };
const feeCard = { background: '#0A1A2E', border: '1px solid #122845', borderRadius: 8, padding: '8px 12px', minWidth: 120 };

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
