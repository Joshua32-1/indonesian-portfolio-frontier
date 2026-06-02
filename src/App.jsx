/**
 * App.jsx  — REFACTORED v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Three-tab layout:
 *   Tab 1: WORKSPACE  — asset toggles, sector caps, simulation controls
 *   Tab 2: SIMULATION — Efficient Frontier scatter cloud
 *   Tab 3: ANALYTICS  — weight breakdowns, risk contributions, asset metrics
 *
 * Simulation flow:
 *   1. Mount → load JSON → computeAnchorMatrices (once, stored as constants)
 *   2. User toggles assets / adjusts sector caps / moves stress slider
 *   3. User clicks REGENERATE:
 *        a. Filter active assets
 *        b. Extract sub-matrices for active tickers
 *        c. Blend sub-matrices for active assets
 *        d. Annualise covariance: Σ = ρ · σᵢ_annual · σⱼ_annual
 *        e. Run 5,500 Monte Carlo iterations with sector constraint enforcement
 *        f. Auto-navigate to Tab 2 to display results
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  computeAnchorMatrices,
  extractSubMatrix,
  blendMatrices,
  computeCovarianceMatrix,
  computeRiskContributions,
} from './math/matrixEngine.js';
import { runMonteCarloSimulation } from './math/monteCarlo.js';
import EfficientFrontier from './components/EfficientFrontier.jsx';

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const MC_ITERATIONS  = 5500;
const DEFAULT_RF     = 0.0525;

const MIN_SECTOR_CAP = 0.20; // 20% minimum cap on the slider

const SECTOR_COLORS = {
  Banking:        '#3B82F6',
  Telecoms:       '#10B981',
  Conglomerate:   '#8B5CF6',
  Transport:      '#EC4899',
  Consumer:       '#F59E0B',
  Infrastructure: '#06B6D4',
  Materials:      '#A78BFA',
  Other:          '#64748B',
};

// Default sector caps (max fraction of portfolio per sector)
const DEFAULT_SECTOR_CAPS = {
  Banking:        0.80,
  Telecoms:       0.80,
  Conglomerate:   0.80,
  Transport:      0.80,
  Consumer:       0.80,
  Infrastructure: 0.80,
  Materials:      0.80,
  Other:          0.80,
};

// Tab identifiers
const TABS = ['WORKSPACE', 'SIMULATION', 'ANALYTICS'];

// Style objects MUST be declared before components that reference them (HMR-safe).
const styles = {
  root:       { minHeight: '100vh', background: '#030A14', fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace", color: '#E2E8F0' },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 20px', borderBottom: '1px solid #0A1628', background: '#07111E', position: 'sticky', top: 0, zIndex: 100 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  appName:    { fontSize: 13, fontWeight: 800, letterSpacing: 3, color: '#E2E8F0' },
  appSub:     { fontSize: 8, color: '#334155', letterSpacing: 1.5, marginTop: 2 },
  headerRight:{ display: 'flex', alignItems: 'center', gap: 10 },
  lastRun:    { fontSize: 8, color: '#64748B', letterSpacing: 0.5 },
  rfBadge:    { background: '#0A1628', border: '1px solid #1E3A5F', borderRadius: 4, padding: '3px 8px', fontSize: 9, color: '#64748B', fontWeight: 700, letterSpacing: 1 },
  tabBar:     { display: 'flex', alignItems: 'center', gap: 0, padding: '0 20px', borderBottom: '1px solid #0A1628', background: '#07111E', position: 'sticky', top: 45, zIndex: 99 },
  tabBtn:     { background: 'none', border: 'none', borderBottom: '2px solid transparent', padding: '10px 18px', fontSize: 10, fontWeight: 700, letterSpacing: 1, cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.15s, border-color 0.15s' },
  regenBtn:   { marginLeft: 'auto', padding: '7px 16px', background: 'linear-gradient(135deg,#0F2337,#1E3A5F)', border: '1px solid #00CFFD44', borderRadius: 5, color: '#00CFFD', fontSize: 10, fontWeight: 800, letterSpacing: 1, fontFamily: 'inherit' },
  main:       { padding: 16, minHeight: 'calc(100vh - 90px)' },
  centred:    { height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#030A14', fontFamily: 'monospace' },
  bigSpinner: { width: 32, height: 32, border: '3px solid #0F2337', borderTopColor: '#00CFFD', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
};

const ws = {
  layout:   { display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16, alignItems: 'start' },
  panel:    { background: '#07111E', border: '1px solid #0F2337', borderRadius: 8, padding: '14px 16px', marginBottom: 12 },
  assetRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, transition: 'all 0.12s', userSelect: 'none' },
  capRow:   { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  capValue: { width: 34, textAlign: 'right', fontSize: 12, fontWeight: 800, fontVariantNumeric: 'tabular-nums' },
  capNumInput: { width: 46, background: '#050D1A', border: '1px solid', borderRadius: 3, padding: '2px 4px', fontSize: 10, fontWeight: 700, textAlign: 'right', outline: 'none', fontFamily: 'monospace' },
};

const an = {
  layout:    { display: 'flex', flexDirection: 'column', gap: 14, minHeight: 400 },
  empty:     { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 400, gap: 12, textAlign: 'center', maxWidth: 380, margin: '0 auto', padding: 24 },
  cardRow:   { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  panel:     { background: '#07111E', border: '1px solid #0F2337', borderRadius: 8, padding: '14px 16px' },
  weightGrid:{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: 10 },
  th:        { padding: '6px 8px', fontSize: 8, color: '#64748B', fontWeight: 700, textAlign: 'right', letterSpacing: 1, textTransform: 'uppercase', borderBottom: '1px solid #0A1628', whiteSpace: 'nowrap' },
  td:        { padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#E2E8F0' },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Root Component
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Data state ───────────────────────────────────────────────────────────
  const [assets,       setAssets]       = useState([]);
  const [riskFreeRate, setRiskFreeRate]  = useState(DEFAULT_RF);
  const [loadStatus,   setLoadStatus]   = useState('loading');
  const [loadError,    setLoadError]    = useState(null);

  // ── Anchor matrices (computed once) ──────────────────────────────────────
  const [matrixA, setMatrixA] = useState(null);
  const [matrixB, setMatrixB] = useState(null);
  const [labels,  setLabels]  = useState([]);

  // ── User controls ─────────────────────────────────────────────────────────
  const [activeSet,    setActiveSet]   = useState(new Set()); // tickers enabled
  const [sectorCaps,   setSectorCaps]  = useState(DEFAULT_SECTOR_CAPS);
  const [stressMix,    setStressMix]   = useState(0.0);       // α ∈ [0,1]
  const [activeTab,    setActiveTab]   = useState(0);

  // ── Simulation state (single bundle keeps Analytics in sync) ─────────────
  const [lastRun,   setLastRun]   = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [simError,  setSimError]  = useState(null);

  const simResult = lastRun?.simResult ?? null;

  // ── 1.  Load snapshot on mount ────────────────────────────────────────────
  useEffect(() => {
    fetch('/data/live-market-snapshot.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(snap => {
        const { assets: raw, riskFreeRate: rf } = snap;
        const { matrixA: mA, matrixB: mB, labels: lbls } = computeAnchorMatrices(raw);
        setAssets(raw);
        setRiskFreeRate(rf ?? DEFAULT_RF);
        setMatrixA(mA);
        setMatrixB(mB);
        setLabels(lbls);
        setActiveSet(new Set(raw.map(a => a.ticker)));
        setLoadStatus('ready');
      })
      .catch(err => { setLoadError(err.message); setLoadStatus('error'); });
  }, []);

  // ── Derived: active asset list ────────────────────────────────────────────
  const activeAssets = useMemo(
    () => assets.filter(a => activeSet.has(a.ticker)),
    [assets, activeSet]
  );

  const activeLabels = useMemo(() => activeAssets.map(a => a.ticker), [activeAssets]);

  // ── 2.  Regenerate Simulation ─────────────────────────────────────────────
  const handleRegenerate = useCallback(() => {
    if (!matrixA || !matrixB || activeAssets.length < 2) return;
    setIsRunning(true);

    setTimeout(() => {
      try {
        setSimError(null);
        const subA = extractSubMatrix(matrixA, labels, activeLabels);
        const subB = extractSubMatrix(matrixB, labels, activeLabels);
        const blended = blendMatrices(subA, subB, stressMix);
        const { covMatrix } = computeCovarianceMatrix(blended, activeAssets);
        const result = runMonteCarloSimulation({
          assets: activeAssets,
          covMatrix,
          sectorCaps,
          riskFreeRate,
          iterations: MC_ITERATIONS,
        });

        setLastRun({
          simResult: result,
          covMatrix,
          activeAssets: activeAssets.map(a => ({ ...a })),
          meta: {
            ts: new Date().toLocaleTimeString(),
            stressMix,
            activeCount: activeAssets.length,
          },
        });
        setActiveTab(1);
      } catch (err) {
        console.error('Simulation failed:', err);
        setSimError(err?.message ?? 'Simulation failed');
      } finally {
        setIsRunning(false);
      }
    }, 30);
  }, [matrixA, matrixB, labels, activeAssets, activeLabels, stressMix, sectorCaps, riskFreeRate]);

  // ─────────────────────────────────────────────────────────────────────────
  //  Loading / Error states
  // ─────────────────────────────────────────────────────────────────────────

  if (loadStatus === 'loading') return (
    <div style={styles.centred}>
      <div style={styles.bigSpinner} />
      <div style={{ color: '#334155', fontSize: 11, marginTop: 14, fontFamily: 'monospace' }}>
        Loading market snapshot…
      </div>
    </div>
  );

  if (loadStatus === 'error') return (
    <div style={styles.centred}>
      <div style={{ fontSize: 30, marginBottom: 10 }}>⚠</div>
      <div style={{ color: '#EF4444', fontSize: 12 }}>{loadError}</div>
      <div style={{ color: '#1E3A5F', fontSize: 9, marginTop: 8, maxWidth: 300, textAlign: 'center', fontFamily: 'monospace' }}>
        Ensure <code style={{ color: '#F59E0B' }}>data/live-market-snapshot.json</code> is served
        or run <code style={{ color: '#F59E0B' }}>npm run fetch-snapshot</code> after changing tickers.
      </div>
    </div>
  );

  // ─────────────────────────────────────────────────────────────────────────
  //  Main Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={styles.root}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #030A14; }
        input[type=range] { accent-color: #00CFFD; }
        ::-webkit-scrollbar { width: 4px; background: #0A1628; }
        ::-webkit-scrollbar-thumb { background: #1E3A5F; border-radius: 2px; }
      `}</style>

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={{ fontSize: 22, color: '#00CFFD', lineHeight: 1 }}>◈</span>
          <div>
            <div style={styles.appName}>IDX PORTFOLIO OPTIMIZER</div>
            <div style={styles.appSub}>Markowitz MPT · Monte Carlo · Regime Stress Testing</div>
          </div>
        </div>
        <div style={styles.headerRight}>
          {lastRun?.meta && (
            <span style={styles.lastRun}>
              {lastRun.meta.ts}  ·  α={lastRun.meta.stressMix.toFixed(2)}  ·  {lastRun.meta.activeCount} assets
            </span>
          )}
          <span style={styles.rfBadge}>RF {(riskFreeRate * 100).toFixed(2)}% · BI RATE</span>
        </div>
      </header>

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div style={styles.tabBar}>
        {TABS.map((name, idx) => (
          <button
            key={name}
            onClick={() => setActiveTab(idx)}
            style={{
              ...styles.tabBtn,
              color:        activeTab === idx ? '#00CFFD' : '#334155',
              borderBottom: activeTab === idx ? '2px solid #00CFFD' : '2px solid transparent',
            }}
          >
            {idx + 1}. {name}
            {idx >= 1 && lastRun && (
              <span style={{ marginLeft: 6, fontSize: 7, color: '#10B981', fontWeight: 700 }}>
                ● LIVE
              </span>
            )}
          </button>
        ))}
        {/* Regenerate sits in the tab bar for quick access */}
        <button
          onClick={handleRegenerate}
          disabled={isRunning || activeAssets.length < 2}
          style={{
            ...styles.regenBtn,
            opacity: (isRunning || activeAssets.length < 2) ? 0.45 : 1,
            cursor:  (isRunning || activeAssets.length < 2) ? 'not-allowed' : 'pointer',
          }}
        >
          {isRunning ? '⟳ RUNNING…' : `▶ REGENERATE  (${MC_ITERATIONS.toLocaleString()} PATHS)`}
        </button>
      </div>

      {/* ── Tab content ──────────────────────────────────────────────────── */}
      <main style={styles.main}>
        {activeTab === 0 && (
          <WorkspaceTab
            assets={assets}
            activeSet={activeSet}
            onToggle={ticker => {
              setActiveSet(prev => {
                const next = new Set(prev);
                if (next.has(ticker) && next.size > 2) next.delete(ticker);
                else next.add(ticker);
                return next;
              });
            }}
            sectorCaps={sectorCaps}
            onSectorCapChange={(sector, val) =>
              setSectorCaps(prev => ({ ...prev, [sector]: val }))
            }
            stressMix={stressMix}
            onStressMixChange={setStressMix}
            matrixA={matrixA}
            matrixB={matrixB}
            labels={labels}
          />
        )}
        {activeTab === 1 && (
          <EfficientFrontier
            simulationResult={simResult}
            isRunning={isRunning}
            stressMix={stressMix}
          />
        )}
        {activeTab === 2 && (
          <AnalyticsTab
            lastRun={lastRun}
            simError={simError}
            riskFreeRate={riskFreeRate}
          />
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tab 1: WORKSPACE
// ─────────────────────────────────────────────────────────────────────────────

function WorkspaceTab({ assets, activeSet, onToggle, sectorCaps, onSectorCapChange, stressMix, onStressMixChange, matrixA, matrixB, labels }) {
  const sectors = useMemo(() => [...new Set(assets.map(a => a.sector))], [assets]);
  const { label: regimeLabel, color: regimeColor } = regimeMeta(stressMix);

  const activeLabels = useMemo(
    () => assets.filter(a => activeSet.has(a.ticker)).map(a => a.ticker),
    [assets, activeSet],
  );

  const corrDiagnostics = useMemo(() => {
    if (!matrixA || !matrixB || activeLabels.length < 2) return null;
    const subA = extractSubMatrix(matrixA, labels, activeLabels);
    const subB = extractSubMatrix(matrixB, labels, activeLabels);
    const blended = blendMatrices(subA, subB, stressMix);
    return [
      { label: 'Matrix A — Regular', stats: matrixRhoStats(subA), color: '#00CFFD' },
      { label: 'Matrix B — Stress', stats: matrixRhoStats(subB), color: '#EF4444' },
      { label: `Blended — α=${stressMix.toFixed(2)} (sim)`, stats: matrixRhoStats(blended), color: '#A78BFA' },
    ];
  }, [matrixA, matrixB, labels, activeLabels, stressMix]);

  return (
    <div style={ws.layout}>

      {/* ── LEFT: Asset Universe ─────────────────────────────────────── */}
      <div style={ws.panel}>
        <SectionHeader>ASSET UNIVERSE — {activeSet.size} / {assets.length} ACTIVE</SectionHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {assets.map(a => {
            const active = activeSet.has(a.ticker);
            const col    = SECTOR_COLORS[a.sector] ?? '#64748B';
            const upside = a.meta.currentPrice
              ? ((a.forwardEstimates.meanTarget - a.meta.currentPrice) / a.meta.currentPrice * 100).toFixed(1)
              : '—';
            const annVol = (a.meta.recentDailyVol * Math.sqrt(252) * 100).toFixed(1);

            return (
              <div
                key={a.ticker}
                onClick={() => onToggle(a.ticker)}
                style={{
                  ...ws.assetRow,
                  background:   active ? '#0A1628' : '#050B17',
                  border:       `1px solid ${active ? col + '44' : '#0A1628'}`,
                  opacity:      active ? 1 : 0.38,
                  cursor:       'pointer',
                }}
              >
                {/* Checkbox visual */}
                <div style={{
                  width: 14, height: 14, borderRadius: 3,
                  border: `2px solid ${active ? col : '#1E3A5F'}`,
                  background: active ? col + '33' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {active && <span style={{ color: col, fontSize: 9, lineHeight: 1, fontWeight: 900 }}>✓</span>}
                </div>

                {/* Ticker + sector */}
                <div style={{ flex: '0 0 80px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: active ? col : '#334155' }}>
                    {a.ticker}
                  </div>
                  <div style={{ fontSize: 8, color: '#334155' }}>{a.sector}</div>
                </div>

                {/* Current price */}
                <div style={{ flex: '0 0 70px', textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: '#E2E8F0' }}>
                    {a.meta.currentPrice?.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 8, color: '#475569' }}>IDR</div>
                </div>

                {/* Analyst consensus → upside */}
                <div style={{ flex: '0 0 72px', textAlign: 'right' }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700,
                    color: parseFloat(upside) >= 0 ? '#00FF88' : '#EF4444',
                  }}>
                    {parseFloat(upside) >= 0 ? '+' : ''}{upside}%
                  </div>
                  <div style={{ fontSize: 8, color: '#475569' }}>upside</div>
                </div>

                {/* Annual vol */}
                <div style={{ flex: '0 0 56px', textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: '#F59E0B' }}>{annVol}%</div>
                  <div style={{ fontSize: 8, color: '#475569' }}>σ ann.</div>
                </div>

                {/* Analyst count */}
                <div style={{ flex: '0 0 36px', textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: '#64748B' }}>
                    {a.forwardEstimates.totalAnalysts ?? '—'}
                  </div>
                  <div style={{ fontSize: 7, color: '#334155' }}>est.</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── RIGHT: Controls ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Sector caps */}
        <div style={ws.panel}>
          <SectionHeader>SECTOR CONCENTRATION CAPS</SectionHeader>
          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 10, lineHeight: 1.5 }}>
            Max portfolio weight per sector (20–100%). Paths above a cap are clipped
            and excess is shifted to other sectors when possible.
          </div>
          {sectors.map(sector => {
            const cap    = Math.max(MIN_SECTOR_CAP, sectorCaps[sector] ?? 0.8);
            const col    = SECTOR_COLORS[sector] ?? '#64748B';
            const count  = assets.filter(a => a.sector === sector).length;
            const clampCap = (v) => Math.max(MIN_SECTOR_CAP, Math.min(1, v));
            return (
              <div key={sector} style={ws.capRow}>
                <div style={{ flex: '0 0 100px' }}>
                  <div style={{ fontSize: 10, color: col, fontWeight: 700 }}>{sector}</div>
                  <div style={{ fontSize: 8, color: '#334155' }}>{count} asset{count !== 1 ? 's' : ''}</div>
                </div>
                <input
                  type="range" min={MIN_SECTOR_CAP} max={1} step={0.01}
                  value={cap}
                  onChange={e => onSectorCapChange(sector, clampCap(parseFloat(e.target.value)))}
                  style={{ flex: 1, accentColor: col }}
                />
                <div style={{ ...ws.capValue, color: cap < 0.35 ? '#EF4444' : col }}>
                  {Math.round(cap * 100)}%
                </div>
                <input
                  type="number" min={20} max={100} step={1}
                  value={Math.round(cap * 100)}
                  onChange={e => onSectorCapChange(sector, clampCap(parseInt(e.target.value, 10) / 100 || MIN_SECTOR_CAP))}
                  style={{ ...ws.capNumInput, borderColor: col + '44', color: col }}
                />
              </div>
            );
          })}
        </div>

        {/* Stress slider */}
        <div style={ws.panel}>
          <SectionHeader>REGIME STRESS MIX  ·  α</SectionHeader>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 30, fontWeight: 800, color: regimeColor, fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(stressMix * 100)}%
            </span>
            <span style={{ fontSize: 10, color: regimeColor, fontWeight: 700, letterSpacing: 1 }}>
              {regimeLabel}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 8, color: '#334155', width: 44 }}>Regular</span>
            <div style={{ position: 'relative', flex: 1, height: 6, background: '#0A1628', borderRadius: 3 }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: 3,
                width: `${stressMix * 100}%`,
                background: 'linear-gradient(to right, #00CFFD, #10B981, #F59E0B, #EF4444)',
              }} />
              <input type="range" min={0} max={100} step={1}
                value={Math.round(stressMix * 100)}
                onChange={e => onStressMixChange(parseInt(e.target.value, 10) / 100)}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
              />
            </div>
            <span style={{ fontSize: 8, color: '#334155', width: 32, textAlign: 'right' }}>Stress</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            {[0, 25, 50, 75, 100].map(v => (
              <button key={v}
                onClick={() => onStressMixChange(v / 100)}
                style={{ background: 'none', border: 'none', fontSize: 8, color: Math.round(stressMix*100)===v ? regimeColor : '#1E3A5F', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700, padding: '2px 4px' }}
              >{v}%</button>
            ))}
          </div>
        </div>

        {corrDiagnostics && (
          <div style={ws.panel}>
            <SectionHeader>CORRELATION DIAGNOSTICS · {activeLabels.length} active</SectionHeader>
            {corrDiagnostics.map(({ label, stats, color }) => (
              <div key={label} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 9, color, fontWeight: 700, marginBottom: 3 }}>{label}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                  {[['avg ρ', stats.avg], ['min ρ', stats.min], ['max ρ', stats.max]].map(([k, v]) => (
                    <div key={k} style={{ background: '#050D1A', borderRadius: 3, padding: '4px 6px' }}>
                      <div style={{ fontSize: 7, color: '#334155' }}>{k}</div>
                      <div style={{ fontSize: 11, color, fontWeight: 700 }}>{v.toFixed(3)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tab 3: ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

function AnalyticsTab({ lastRun, simError, riskFreeRate }) {
  if (!lastRun) {
    return (
      <div style={an.empty}>
        <div style={{ fontSize: 28 }}>📊</div>
        <div style={{ color: '#E2E8F0', fontWeight: 700, fontSize: 13 }}>No analytics yet</div>
        <p style={{ color: '#94A3B8', lineHeight: 1.6, margin: 0 }}>
          Enable at least <strong style={{ color: '#E2E8F0' }}>2 assets</strong>, then click{' '}
          <strong style={{ color: '#00CFFD' }}>▶ REGENERATE</strong>.
        </p>
        {simError && (
          <p style={{ color: '#EF4444', margin: 0, fontSize: 11 }}>Last run failed: {simError}</p>
        )}
      </div>
    );
  }

  const { simResult, covMatrix, activeAssets } = lastRun;

  if (!simResult) {
    return (
      <div style={an.empty}>
        <div style={{ color: '#EF4444', fontWeight: 700 }}>Analytics data incomplete</div>
        <p style={{ color: '#94A3B8', margin: 0 }}>Click REGENERATE.</p>
      </div>
    );
  }

  const { maxSharpePortfolio: msp, minVariancePortfolio: mvp } = simResult;

  if (!msp?.weights || !mvp?.weights || activeAssets.length < 2) {
    return (
      <div style={an.empty}>
        <div style={{ color: '#EF4444', fontWeight: 700 }}>Invalid simulation output</div>
        <p style={{ color: '#94A3B8', margin: 0 }}>Click REGENERATE again.</p>
      </div>
    );
  }

  const n = activeAssets.length;
  if (msp.weights.length !== n || mvp.weights.length !== n || covMatrix.length !== n) {
    return (
      <div style={an.empty}>
        <div style={{ color: '#EF4444', fontWeight: 700 }}>Data size mismatch</div>
        <p style={{ color: '#94A3B8', margin: 0 }}>REGENERATE to refresh analytics.</p>
      </div>
    );
  }

  const mspRC  = computeRiskContributions(msp.weights, covMatrix);
  const mvpRC  = computeRiskContributions(mvp.weights, covMatrix);

  const eqW = Array(n).fill(1 / n);
  const eqRC = computeRiskContributions(eqW, covMatrix);

  const annVols = activeAssets.map(a => a.meta.recentDailyVol * Math.sqrt(252));

  // PERT mean returns for display
  const pertMeans = activeAssets.map(a => {
    const px = a.meta.currentPrice;
    const mean = a.forwardEstimates?.meanTarget;
    if (!px || mean == null) return 0;
    return (mean - px) / px;
  });

  return (
    <div style={an.layout}>

      {/* ── Summary cards ─────────────────────────────────────────────── */}
      <div style={an.cardRow}>
        <PortfolioSummaryCard
          title="MAX SHARPE PORTFOLIO"
          icon="★"
          color="#FFD700"
          portfolio={msp}
          riskFreeRate={riskFreeRate}
        />
        <PortfolioSummaryCard
          title="MIN VARIANCE PORTFOLIO"
          icon="◆"
          color="#00CFFD"
          portfolio={mvp}
          riskFreeRate={riskFreeRate}
        />
      </div>

      {/* ── Weight comparison ─────────────────────────────────────────── */}
      <div style={an.panel}>
        <SectionHeader>WEIGHT ALLOCATION COMPARISON</SectionHeader>
        <div style={an.weightGrid}>
          {/* Max Sharpe bars */}
          <div>
            <div style={{ fontSize: 9, color: '#FFD700', fontWeight: 700, marginBottom: 8, letterSpacing: 1 }}>
              ★ MAX SHARPE
            </div>
            {activeAssets.map((a, i) => (
              <WeightBar
                key={a.ticker} ticker={a.ticker} sector={a.sector}
                weight={msp.weights[i] ?? 0}
                rcFrac={mspRC[i] ?? 0}
              />
            ))}
          </div>
          {/* Min Variance bars */}
          <div>
            <div style={{ fontSize: 9, color: '#00CFFD', fontWeight: 700, marginBottom: 8, letterSpacing: 1 }}>
              ◆ MIN VARIANCE
            </div>
            {activeAssets.map((a, i) => (
              <WeightBar
                key={a.ticker} ticker={a.ticker} sector={a.sector}
                weight={mvp.weights[i] ?? 0}
                rcFrac={mvpRC[i] ?? 0}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── Asset metrics table ───────────────────────────────────────── */}
      <div style={an.panel}>
        <SectionHeader>PER-ASSET METRICS</SectionHeader>
        <div style={{ overflowX: 'auto' }}>
          <table style={an.table}>
            <thead>
              <tr>
                {['Asset', 'Sector', 'σ annual', 'E[r] consensus', 'MSP weight', 'MSP RC', 'MVP weight', 'MVP RC', 'EW RC'].map(h => (
                  <th key={h} style={an.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeAssets.map((a, i) => {
                const col = SECTOR_COLORS[a.sector] ?? '#64748B';
                return (
                  <tr key={a.ticker} style={{ background: i % 2 === 0 ? '#050D1A' : '#07111E' }}>
                    <td style={{ ...an.td, color: col, fontWeight: 700 }}>{a.ticker}</td>
                    <td style={{ ...an.td, color: '#475569' }}>{a.sector}</td>
                    <td style={{ ...an.td, color: '#F59E0B' }}>{(annVols[i] * 100).toFixed(1)}%</td>
                    <td style={{ ...an.td, color: pertMeans[i] >= 0 ? '#00FF88' : '#EF4444' }}>
                      {(pertMeans[i] * 100) >= 0 ? '+' : ''}{(pertMeans[i] * 100).toFixed(1)}%
                    </td>
                    <td style={{ ...an.td, color: '#FFD700' }}>{((msp.weights[i] ?? 0) * 100).toFixed(1)}%</td>
                    <td style={{ ...an.td, color: '#FFD70088' }}>{((mspRC[i] ?? 0) * 100).toFixed(1)}%</td>
                    <td style={{ ...an.td, color: '#00CFFD' }}>{((mvp.weights[i] ?? 0) * 100).toFixed(1)}%</td>
                    <td style={{ ...an.td, color: '#00CFFD88' }}>{((mvpRC[i] ?? 0) * 100).toFixed(1)}%</td>
                    <td style={{ ...an.td, color: '#64748B' }}>{((eqRC[i] ?? 0) * 100).toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8, fontSize: 8, color: '#1E3A5F', lineHeight: 1.5 }}>
          RC = Risk Contribution — percentage of total portfolio variance attributable to each asset.
          Concentrated RC values (one asset &gt;40%) signal hidden concentration risk even in
          seemingly diversified portfolios.
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Small reusable sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SectionHeader({ children }) {
  return (
    <div style={{ fontSize: 9, color: '#334155', letterSpacing: 1.5, fontWeight: 700, textTransform: 'uppercase', marginBottom: 10 }}>
      {children}
    </div>
  );
}

function PortfolioSummaryCard({ title, icon, color, portfolio, riskFreeRate }) {
  if (!portfolio) return null;
  const ret    = ((portfolio.portfolioReturn ?? 0) * 100).toFixed(2);
  const risk   = ((portfolio.portfolioRisk ?? 0) * 100).toFixed(2);
  const sharpe = (portfolio.portfolioSharpe ?? 0).toFixed(3);
  return (
    <div style={{ background: '#07111E', border: `1px solid ${color}33`, borderRadius: 8, padding: '14px 16px', flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color, fontSize: 16 }}>{icon}</span>
        <span style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: 1 }}>{title}</span>
      </div>
      {[
        ['Return μ (ann.)',  `${parseFloat(ret) >= 0 ? '+' : ''}${ret}%`,  parseFloat(ret) >= 0 ? '#00FF88' : '#EF4444'],
        ['Risk σ (ann.)',    `${risk}%`,                                     '#00CFFD'],
        ['Sharpe Ratio',    sharpe,                                          parseFloat(sharpe) > 1 ? '#FFD700' : parseFloat(sharpe) > 0.5 ? '#F59E0B' : '#EF4444'],
        ['Excess Return',   `${((parseFloat(ret)/100 - riskFreeRate) * 100).toFixed(2)}%`, '#94A3B8'],
      ].map(([k, v, c]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 9, color: '#475569' }}>{k}</span>
          <span style={{ fontSize: 13, color: c, fontWeight: 800 }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function WeightBar({ ticker, sector, weight, rcFrac }) {
  const col = SECTOR_COLORS[sector] ?? '#64748B';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
      <span style={{ width: 40, fontSize: 10, color: col, fontWeight: 700 }}>{ticker}</span>
      <div style={{ flex: 1, position: 'relative' }}>
        {/* Weight bar */}
        <div style={{ height: 8, background: '#0A1628', borderRadius: 2, overflow: 'hidden', marginBottom: 2 }}>
          <div style={{ height: '100%', width: `${Math.min(weight * 100, 100)}%`, background: col, opacity: 0.8, borderRadius: 2, transition: 'width 0.2s' }} />
        </div>
        {/* RC bar (overlaid, semi-transparent) */}
        <div style={{ height: 4, background: '#0A1628', borderRadius: 1, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(rcFrac * 100, 100)}%`, background: '#F59E0B', opacity: 0.6, borderRadius: 1 }} />
        </div>
      </div>
      <div style={{ width: 80, textAlign: 'right' }}>
        <span style={{ fontSize: 10, color: col, fontVariantNumeric: 'tabular-nums' }}>{(weight * 100).toFixed(1)}%</span>
        <span style={{ fontSize: 8, color: '#334155', marginLeft: 4 }}>RC:{(rcFrac * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Off-diagonal avg / min / max ρ for an N×N correlation matrix. */
function matrixRhoStats(mat) {
  const off = [];
  for (let i = 0; i < mat.length; i++)
    for (let j = i + 1; j < mat.length; j++) off.push(mat[i][j]);
  if (!off.length) return { avg: 0, min: 0, max: 0 };
  const sum = off.reduce((s, v) => s + v, 0);
  return { avg: sum / off.length, min: Math.min(...off), max: Math.max(...off) };
}

function regimeMeta(alpha) {
  if (alpha < 0.15) return { label: 'BULL MARKET',   color: '#00CFFD' };
  if (alpha < 0.35) return { label: 'MILD STRESS',   color: '#10B981' };
  if (alpha < 0.60) return { label: 'MODERATE BEAR', color: '#F59E0B' };
  if (alpha < 0.80) return { label: 'STRESS REGIME', color: '#F97316' };
  return               { label: 'FULL CRISIS',    color: '#EF4444' };
}
