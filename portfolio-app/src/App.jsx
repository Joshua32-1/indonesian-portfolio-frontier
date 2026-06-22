/**
 * App.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Four-tab layout:
 *   Tab 1: WORKSPACE   — asset toggles, sector caps, vol & simulation controls
 *   Tab 2: CORRELATION — date-range ρ picker + price chart
 *   Tab 3: SIMULATION  — Efficient Frontier scatter cloud
 *   Tab 4: ANALYTICS   — weight breakdowns, risk contributions
 *
 * Simulation flow:
 *   1. Mount → load JSON snapshot
 *   2. User sets correlation window on CORRELATION tab
 *   3. REGENERATE → ρ from date range → Σ → Monte Carlo
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  computeCovarianceMatrix,
  computeRiskContributions,
  formatRiskContributionPct,
  riskContributionBarWidth,
  resolveDailyVol,
  computeCorrelationFromDateRange,
  todayISO,
  availableHistoryRange,
  alignedHistoryRange,
  reconcilePortfolioSharpe,
  MIN_CORR_OBS,
  DEFAULT_VOL_HALF_LIFE,
  SQRT_252,
} from './math/matrixEngine.js';
import { runMonteCarloSimulation, buildScenarioBank, evaluateStressScenarios } from './math/monteCarlo.js';
import {
  MIN_SECTOR_CAP,
  buildSectorCapsForSectors,
  resolveSectorCap,
  computeSectorWeights,
} from './math/sectorCaps.js';
import { DEFAULT_FACTOR_CONFIG, formatFactorConfigSummary } from './math/factorConfig.js';
import { computeFactorPreview } from './math/qualityFactors.js';
import { buildSectorColorMap, getSectorColor } from './sectorColors.js';
import { DEFAULT_SIM_CONFIG, DEFAULT_TAIL_PENALTY } from './math/simConfig.js';
import { buildRebalanceTrades, computeTurnover } from './math/robustObjective.js';
import { computeBenchmarkMetrics } from './math/benchmarkMetrics.js';
import {
  priceUpsideDecimal,
  totalUpsideDecimal,
  dividendYield,
  hasDividend,
  consensusTotalUpside,
  fmtUpsidePct,
} from './math/returns.js';
import EfficientFrontier from './components/EfficientFrontier.jsx';
import CorrelationExplorer from './components/CorrelationExplorer.jsx';

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MC_ITERATIONS = 100000;
const MIN_MC_ITERATIONS     = 1000;
const MAX_MC_ITERATIONS     = 100000;
const DEFAULT_RF            = 0.0575;
const MIN_RF                = 0;
const MAX_RF                = 0.15;

const DEFAULT_MAX_POSITION_CAP = 1.0; // 100% = no single-stock cap
const MIN_MAX_POSITION_CAP = 0.05; // 5% minimum per-stock cap on slider

const MIN_TAU = 0.005;
const MAX_TAU = 0.15;

// Tab identifiers
const TABS = ['WORKSPACE', 'CORRELATION', 'SIMULATION', 'ANALYTICS'];

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
  cardRow:   { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 },
  panel:     { background: '#07111E', border: '1px solid #0F2337', borderRadius: 8, padding: '14px 16px' },
  weightGrid:{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: 10 },
  th:        { padding: '6px 8px', fontSize: 8, color: '#64748B', fontWeight: 700, textAlign: 'right', letterSpacing: 1, textTransform: 'uppercase', borderBottom: '1px solid #0A1628', whiteSpace: 'nowrap' },
  td:        { padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#E2E8F0' },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Bank helpers (module-level, no React)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces a stable string key from all inputs that determine the scenario bank.
 * If any of these change, the bank must be rebuilt.
 */
function computeBankKey({ activeTickers, corrStart, corrEnd, volHalfLife,
    shrinkage, factorConfig, mcIterations, optimizerPaths,
    riskFreeRate, maxPositionCap, snapshotGenerated }) {
  return JSON.stringify({
    t:  [...activeTickers].sort().join(','),
    cs: corrStart,  ce: corrEnd,
    vh: volHalfLife, sh: !!shrinkage,
    fc: JSON.stringify(factorConfig),
    n:  mcIterations, op: optimizerPaths,
    rf: riskFreeRate, pc: maxPositionCap,
    sg: snapshotGenerated,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Root Component
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Data state ───────────────────────────────────────────────────────────
  const [assets,       setAssets]       = useState([]);
  const [benchmark,    setBenchmark]    = useState(null);
  const [historyRange, setHistoryRange] = useState(null);
  const [riskFreeRate, setRiskFreeRate]  = useState(DEFAULT_RF);
  const [loadStatus,   setLoadStatus]   = useState('loading');
  const [loadError,    setLoadError]    = useState(null);

  // ── User controls ─────────────────────────────────────────────────────────
  const [activeSet,        setActiveSet]        = useState(new Set());
  const [sectorCaps,       setSectorCaps]       = useState({});
  const [maxPositionCap,   setMaxPositionCap]   = useState(DEFAULT_MAX_POSITION_CAP);
  const [volHalfLife,      setVolHalfLife]      = useState(DEFAULT_VOL_HALF_LIFE);
  const [mcIterations,     setMcIterations]     = useState(DEFAULT_MC_ITERATIONS);
  const [corrStart,        setCorrStart]        = useState('');
  const [corrEnd,          setCorrEnd]          = useState('');
  const [lastCorrActiveKey,setLastCorrActiveKey] = useState('');
  const [activeTab,        setActiveTab]        = useState(0);
  const [factorConfig,     setFactorConfig]     = useState({ ...DEFAULT_FACTOR_CONFIG });
  const [simConfig,        setSimConfig]        = useState({ ...DEFAULT_SIM_CONFIG });
  const [currentWeights,   setCurrentWeights]   = useState({});
  const [assetMaxWeights,  setAssetMaxWeights]  = useState({}); // ticker → max weight fraction (0–1)

  // ── Scenario bank ─────────────────────────────────────────────────────────
  const scenarioBankRef  = useRef(null);
  const [bankInfo, setBankInfo] = useState(null); // { builtAt, pathCount, optimizerPaths }
  const [snapshotGenerated, setSnapshotGenerated] = useState('');

  const updateFactorConfig = useCallback((patch) => {
    setFactorConfig(prev => ({ ...prev, ...patch }));
  }, []);
  const updateSimConfig = useCallback((patch) => {
    setSimConfig(prev => ({ ...prev, ...patch }));
  }, []);

  // ── Simulation state (single bundle keeps Analytics in sync) ─────────────
  const [lastRun,   setLastRun]   = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [simError,  setSimError]  = useState(null);

  const simResult = lastRun?.simResult ?? null;

  // ── 1.  Load snapshot on mount ────────────────────────────────────────────
  useEffect(() => {
    fetch('/live-market-snapshot.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(snap => {
        const { assets: raw, riskFreeRate: rf, benchmark: bench, historyRange: hr } = snap;
        const range = hr
          ? { min: hr.min ?? hr.start, max: hr.max ?? hr.end, interval: hr.interval }
          : availableHistoryRange(raw, bench?.priceHistory);
        setAssets(raw);
        setBenchmark(bench ?? null);
        setHistoryRange(range);
        setRiskFreeRate(rf ?? DEFAULT_RF);
        const sectors = [...new Set(raw.map(a => a.sector))];
        setSectorCaps(buildSectorCapsForSectors(sectors));
        const initialActive = new Set(raw.map(a => a.ticker));
        setActiveSet(initialActive);
        const aligned = alignedHistoryRange(raw);
        const bounds = aligned ?? range;
        if (bounds?.min) {
          setCorrStart(bounds.min);
          setCorrEnd(todayISO());
        }
        setLastCorrActiveKey(raw.map(a => a.ticker).sort().join(','));
        setSnapshotGenerated(snap.generated ?? '');
        setLoadStatus('ready');
      })
      .catch(err => { setLoadError(err.message); setLoadStatus('error'); });
  }, []);

  // Sync sector cap entries when snapshot sectors change (preserve user overrides).
  useEffect(() => {
    if (assets.length === 0) return;
    const sectors = [...new Set(assets.map(a => a.sector))];
    setSectorCaps(prev => buildSectorCapsForSectors(sectors, prev));
  }, [assets]);

  // ── Derived: active asset list ────────────────────────────────────────────
  const activeAssets = useMemo(
    () => assets.filter(a => activeSet.has(a.ticker)),
    [assets, activeSet]
  );

  const activeLabels = useMemo(() => activeAssets.map(a => a.ticker), [activeAssets]);
  const activeKey = useMemo(() => [...activeSet].sort().join(','), [activeSet]);
  const corrStale = lastCorrActiveKey !== '' && lastCorrActiveKey !== activeKey;
  const sectorColors = useMemo(
    () => buildSectorColorMap(assets.map(a => a.sector)),
    [assets]
  );

  // ── 2a. Regenerate correlation window for active universe ─────────────────
  const handleRegenerateCorrelation = useCallback(() => {
    if (activeAssets.length < 2) return;
    const range = alignedHistoryRange(activeAssets);
    if (range) {
      setCorrStart(range.min);
      setCorrEnd(todayISO());
    }
    setLastCorrActiveKey(activeKey);
  }, [activeAssets, activeKey]);

  // ── 2b. Regenerate Simulation ─────────────────────────────────────────────
  const handleRegenerate = useCallback(() => {
    if (activeAssets.length < 2) return;
    setIsRunning(true);

    setTimeout(() => {
      try {
        setSimError(null);

        if (!assets.some(a => a.priceHistory?.dates?.length)) {
          throw new Error('Price history missing — run npm run fetch-snapshot');
        }

        let corrWindowStart = corrStart;
        let corrWindowEnd = corrEnd;
        let { matrix, obs } = computeCorrelationFromDateRange(activeAssets, corrWindowStart, corrWindowEnd);

        if (obs < MIN_CORR_OBS) {
          const aligned = alignedHistoryRange(activeAssets);
          if (aligned) {
            const fallback = computeCorrelationFromDateRange(activeAssets, aligned.min, todayISO());
            if (fallback.obs > obs) {
              matrix = fallback.matrix;
              obs = fallback.obs;
              corrWindowStart = aligned.min;
              corrWindowEnd = todayISO();
            }
          }
        }

        const { covMatrix } = computeCovarianceMatrix(matrix, activeAssets, {
          volHalfLife,
          shrinkage: simConfig.shrinkage,
          nObs: obs,
        });

        // Convert currentWeights from { ticker: pct } to per-asset fraction array
        const cwFractions = activeAssets.map(a => (currentWeights[a.ticker] ?? 0) / 100);
        const hasCW = cwFractions.some(w => w > 0);

        const userCaps = Object.fromEntries(
          activeAssets
            .filter(a => Number.isFinite(assetMaxWeights[a.ticker]))
            .map(a => [a.ticker, assetMaxWeights[a.ticker]]),
        );

        // ── Bank: build once per distinct (snapshot/corr/factorConfig) tuple ──
        const newBankKey = computeBankKey({
          activeTickers: activeSet,
          corrStart, corrEnd, volHalfLife,
          shrinkage: simConfig.shrinkage,
          factorConfig,
          mcIterations,
          optimizerPaths: simConfig.optimizerPaths,
          riskFreeRate,
          maxPositionCap,
          snapshotGenerated,
        });

        let bank = scenarioBankRef.current;
        if (!bank || bank.bankKey !== newBankKey) {
          bank = buildScenarioBank({
            assets: activeAssets,
            covMatrix,
            factorConfig,
            iterations: mcIterations,
            optimizerPaths: simConfig.optimizerPaths,
            riskFreeRate,
            maxPositionCap,
            userPositionCaps: userCaps,
          });
          bank.bankKey = newBankKey;
          scenarioBankRef.current = bank;
          setBankInfo({
            builtAt:       new Date().toLocaleTimeString(),
            pathCount:     mcIterations,
            optimizerPaths: simConfig.optimizerPaths,
          });
        }

        const result = runMonteCarloSimulation({
          assets: activeAssets,
          covMatrix,
          sectorCaps,
          maxPositionCap,
          riskFreeRate,
          iterations: mcIterations,
          factorConfig,
          robustMode:         simConfig.robustMode,
          tailPenalty:        simConfig.tailPenalty,
          currentWeights:     hasCW ? cwFractions : null,
          turnoverPenalty:    hasCW ? simConfig.turnoverPenalty : 0,
          userPositionCaps:   userCaps,
          prebuiltBank:       bank,
          deterministicStarts: simConfig.deterministicStarts,
          optimizerPaths:     simConfig.optimizerPaths,
        });

        setLastRun({
          simResult: result,
          covMatrix,
          simCov: result.simCov ?? covMatrix,
          activeAssets: activeAssets.map(a => ({ ...a })),
          currentWeightsFractions: hasCW ? cwFractions : null,
          benchmark,
          corrStart,
          corrEnd,
          corrWindowStart,
          corrWindowEnd,
          corrObs: obs,
          meta: {
            ts: new Date().toLocaleTimeString(),
            volHalfLife,
            maxPositionCap,
            mcIterations,
            corrStart,
            corrEnd,
            activeCount: activeAssets.length,
            factorConfig: { ...factorConfig },
            sectorCaps: { ...sectorCaps },
            assetMaxWeights: { ...assetMaxWeights },
            simConfig: { ...simConfig },
          },
        });
        setActiveTab(2);
      } catch (err) {
        console.error('Simulation failed:', err);
        setSimError(err?.message ?? 'Simulation failed');
      } finally {
        setIsRunning(false);
      }
    }, 30);
  }, [activeAssets, activeSet, corrStart, corrEnd, volHalfLife, mcIterations, sectorCaps, maxPositionCap, riskFreeRate, factorConfig, assets, simConfig, currentWeights, assetMaxWeights, benchmark, snapshotGenerated]);

  // ── Refresh bank: forces a new MC draw on next REGENERATE ────────────────
  const handleRefreshBank = useCallback(() => {
    scenarioBankRef.current = null;
    setBankInfo(null);
    handleRegenerate();
  }, [handleRegenerate]);

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
            <div style={styles.appSub}>Markowitz MPT · Monte Carlo · Custom Correlation</div>
          </div>
        </div>
        <div style={styles.headerRight}>
          {lastRun?.meta && (
            <span style={styles.lastRun}>
              {lastRun.meta.ts}
              {`  ·  ρ ${lastRun.meta.corrStart}→${lastRun.meta.corrEnd}`}
              {'  ·  '}{lastRun.meta.activeCount} assets
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
            {idx >= 2 && lastRun && (
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
          {isRunning ? '⟳ RUNNING…' : `▶ REGENERATE  (${mcIterations.toLocaleString()} PATHS)`}
        </button>
      </div>

      {/* ── Tab content ──────────────────────────────────────────────────── */}
      <main style={styles.main}>
        {activeTab === 0 && (
          <WorkspaceTab
            assets={assets}
            activeSet={activeSet}
            sectorColors={sectorColors}
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
            maxPositionCap={maxPositionCap}
            onMaxPositionCapChange={setMaxPositionCap}
            activeAssetCount={activeSet.size}
            volHalfLife={volHalfLife}
            onVolHalfLifeChange={setVolHalfLife}
            mcIterations={mcIterations}
            onMcIterationsChange={setMcIterations}
            riskFreeRate={riskFreeRate}
            onRiskFreeRateChange={setRiskFreeRate}
            factorConfig={factorConfig}
            onFactorConfigChange={updateFactorConfig}
            simConfig={simConfig}
            onSimConfigChange={updateSimConfig}
            currentWeights={currentWeights}
            onCurrentWeightsChange={setCurrentWeights}
            assetMaxWeights={assetMaxWeights}
            onAssetMaxWeightChange={(ticker, fraction) =>
              setAssetMaxWeights(prev => {
                const next = { ...prev };
                if (fraction == null) delete next[ticker];
                else next[ticker] = fraction;
                return next;
              })
            }
            activeAssets={activeAssets}
            corrStart={corrStart}
            corrEnd={corrEnd}
            lastRun={lastRun}
            bankInfo={bankInfo}
            onRefreshBank={handleRefreshBank}
          />
        )}
        {activeTab === 1 && (
          <CorrelationExplorer
            assets={assets}
            activeAssets={activeAssets}
            benchmark={benchmark}
            activeSet={activeSet}
            sectorColors={sectorColors}
            corrStart={corrStart}
            corrEnd={corrEnd}
            corrStale={corrStale}
            onCorrStartChange={setCorrStart}
            onCorrEndChange={setCorrEnd}
            onRegenerateCorrelation={handleRegenerateCorrelation}
          />
        )}
        {activeTab === 2 && (
          <EfficientFrontier
            simulationResult={simResult}
            isRunning={isRunning}
            corrStart={corrStart}
            corrEnd={corrEnd}
            riskFreeRate={riskFreeRate}
            mcIterations={mcIterations}
          />
        )}
        {activeTab === 3 && (
          <AnalyticsTab
            lastRun={lastRun}
            simError={simError}
            riskFreeRate={riskFreeRate}
            sectorColors={sectorColors}
            benchmark={benchmark}
            factorConfig={factorConfig}
          />
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tab 1: WORKSPACE
// ─────────────────────────────────────────────────────────────────────────────

function WorkspaceTab({ assets, activeSet, onToggle, sectorCaps, onSectorCapChange, maxPositionCap, onMaxPositionCapChange, activeAssetCount, volHalfLife, onVolHalfLifeChange, mcIterations, onMcIterationsChange, riskFreeRate, onRiskFreeRateChange, sectorColors, factorConfig, onFactorConfigChange, simConfig, onSimConfigChange, currentWeights, onCurrentWeightsChange, assetMaxWeights, onAssetMaxWeightChange, activeAssets, corrStart, corrEnd, lastRun, bankInfo, onRefreshBank }) {
  const sectors = useMemo(() => [...new Set(assets.map(a => a.sector))], [assets]);

  const factorPreview = useMemo(() => {
    if (activeAssets.length < 1) return null;

    let covMatrix = null;
    if (activeAssets.length >= 2) {
      try {
        const { matrix } = computeCorrelationFromDateRange(activeAssets, corrStart, corrEnd);
        covMatrix = computeCovarianceMatrix(matrix, activeAssets, { volHalfLife }).covMatrix;
      } catch {
        covMatrix = null;
      }
    }

    if (!covMatrix) {
      covMatrix = activeAssets.map((a, i) =>
        Array.from({ length: activeAssets.length }, (_, j) => {
          if (i !== j) return 0;
          const vol = resolveDailyVol(a, volHalfLife) * SQRT_252;
          return vol * vol;
        }),
      );
    }

    return computeFactorPreview(activeAssets, covMatrix, factorConfig, maxPositionCap, riskFreeRate, assetMaxWeights);
  }, [activeAssets, corrStart, corrEnd, volHalfLife, factorConfig, maxPositionCap, riskFreeRate, assetMaxWeights]);

  return (
    <div style={ws.layout}>

      {/* ── LEFT: Asset Universe ─────────────────────────────────────── */}
      <div style={ws.panel}>
        <SectionHeader>ASSET UNIVERSE — {activeSet.size} / {assets.length} ACTIVE</SectionHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 6px', opacity: 0.55 }}>
          <div style={{ width: 14 }} />
          <div style={{ flex: '0 0 72px', fontSize: 7, color: '#334155', letterSpacing: 0.8 }}>ASSET</div>
          <div style={{ flex: '0 0 62px', fontSize: 7, color: '#334155', letterSpacing: 0.8, textAlign: 'right' }}>PRICE</div>
          <div style={{ flex: '0 0 48px', fontSize: 7, color: '#334155', letterSpacing: 0.8, textAlign: 'right' }}>YIELD</div>
          <div style={{ flex: '0 0 52px', fontSize: 7, color: '#334155', letterSpacing: 0.8, textAlign: 'right' }}>P UPSIDE</div>
          <div style={{ flex: '0 0 52px', fontSize: 7, color: '#334155', letterSpacing: 0.8, textAlign: 'right' }}>TOTAL↑</div>
          <div style={{ flex: '0 0 48px', fontSize: 7, color: '#334155', letterSpacing: 0.8, textAlign: 'right' }}>σ ANN</div>
          <div style={{ flex: '0 0 28px', fontSize: 7, color: '#334155', letterSpacing: 0.8, textAlign: 'right' }}>EST</div>
          <div style={{ flex: '0 0 52px', fontSize: 7, color: '#334155', letterSpacing: 0.8, textAlign: 'right' }}>MAX WT</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {assets.map(a => {
            const active = activeSet.has(a.ticker);
            const col    = getSectorColor(a.sector, sectorColors);
            const px     = a.meta.currentPrice;
            const mean   = a.forwardEstimates.meanTarget;
            const divYield = dividendYield(a);
            const priceUpside = priceUpsideDecimal(px, mean);
            const totalUpside = totalUpsideDecimal(px, mean, divYield);
            const annVol = (resolveDailyVol(a, volHalfLife) * SQRT_252 * 100).toFixed(1);

            const userCap = assetMaxWeights[a.ticker];
            const hasUserCap = Number.isFinite(userCap);
            const previewRow = factorPreview?.rows?.find(r => r.ticker === a.ticker);
            const effectiveCap = previewRow?.effCap
              ?? (userCap > 0 ? Math.min(maxPositionCap, userCap) : maxPositionCap);
            const capTighterThanGlobal = effectiveCap < maxPositionCap - 0.005;

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
                <div style={{ flex: '0 0 72px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: active ? col : '#334155' }}>
                    {a.ticker}
                  </div>
                  <div style={{ fontSize: 8, color: '#334155' }}>{a.sector}</div>
                </div>

                {/* Current price */}
                <div style={{ flex: '0 0 62px', textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: '#E2E8F0' }}>
                    {px?.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 8, color: '#475569' }}>IDR</div>
                </div>

                {/* Dividend yield */}
                <div style={{ flex: '0 0 48px', textAlign: 'right' }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: hasDividend(a) ? 700 : 400,
                    color: hasDividend(a) ? '#A78BFA' : '#334155',
                  }}>
                    {hasDividend(a) ? `${(divYield * 100).toFixed(1)}%` : '—'}
                  </div>
                  <div style={{ fontSize: 8, color: '#475569' }}>
                    {hasDividend(a) ? 'div' : 'no div'}
                  </div>
                </div>

                {/* Price-only upside */}
                <div style={{ flex: '0 0 52px', textAlign: 'right' }}>
                  <UpsideValue value={priceUpside} />
                  <div style={{ fontSize: 8, color: '#475569' }}>price</div>
                </div>

                {/* Total upside (price + dividend yield) */}
                <div style={{ flex: '0 0 52px', textAlign: 'right' }}>
                  <UpsideValue value={totalUpside} emphasized />
                  <div style={{ fontSize: 8, color: '#475569' }}>total</div>
                </div>

                {/* Annual vol */}
                <div style={{ flex: '0 0 48px', textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: '#F59E0B' }}>{annVol}%</div>
                  <div style={{ fontSize: 8, color: '#475569' }}>σ θ-decay</div>
                </div>

                {/* Analyst count */}
                <div style={{ flex: '0 0 28px', textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: '#64748B' }}>
                    {a.forwardEstimates.totalAnalysts ?? '—'}
                  </div>
                  <div style={{ fontSize: 7, color: '#334155' }}>est.</div>
                </div>

                {/* Per-stock max weight */}
                <div
                  style={{ flex: '0 0 52px', textAlign: 'right' }}
                  onClick={e => e.stopPropagation()}
                  onMouseDown={e => e.stopPropagation()}
                >
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={3}
                    value={hasUserCap ? String(Math.round(userCap * 100)) : ''}
                    placeholder={maxPositionCap >= 1 ? '—' : `${Math.round(maxPositionCap * 100)}`}
                    onChange={e => {
                      const v = e.target.value;
                      if (v === '') {
                        onAssetMaxWeightChange(a.ticker, null);
                        return;
                      }
                      if (!/^\d+$/.test(v)) return;
                      const raw = parseInt(v, 10);
                      if (raw > 100) return;
                      onAssetMaxWeightChange(a.ticker, raw / 100);
                    }}
                    style={{
                      ...ws.capNumInput,
                      width: 44,
                      color: hasUserCap ? '#A78BFA' : '#475569',
                      borderColor: hasUserCap ? '#A78BFA66' : '#1E3A5F',
                      opacity: active ? 1 : 0.6,
                      MozAppearance: 'textfield',
                      WebkitAppearance: 'none',
                      appearance: 'none',
                    }}
                  />
                  <div style={{ fontSize: 7, color: hasUserCap || capTighterThanGlobal ? '#A78BFA' : '#334155', marginTop: 2 }}>
                    {hasUserCap || capTighterThanGlobal
                      ? `${Math.round(effectiveCap * 100)}% eff`
                      : 'max %'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── RIGHT: Controls ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Single-stock cap */}
        <div style={ws.panel}>
          <SectionHeader>MAX SINGLE-STOCK WEIGHT</SectionHeader>
          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 10, lineHeight: 1.5 }}>
            Caps any one position at this weight. Excess is shifted to other stocks
            that still have room under this cap and their sector limit.
            Per-stock overrides in the asset list use the tighter of global and row cap.
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 30, fontWeight: 800, color: '#A78BFA', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(maxPositionCap * 100)}%
            </span>
            <span style={{ fontSize: 10, color: '#A78BFA', fontWeight: 700, letterSpacing: 1 }}>
              {maxPositionCap >= 1 ? 'NO CAP' : 'PER STOCK'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 8, color: '#334155', width: 44 }}>5%</span>
            <input
              type="range"
              min={MIN_MAX_POSITION_CAP}
              max={1}
              step={0.01}
              value={maxPositionCap}
              onChange={e => onMaxPositionCapChange(parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: '#A78BFA' }}
            />
            <span style={{ fontSize: 8, color: '#334155', width: 32, textAlign: 'right' }}>100%</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            {[0.10, 0.15, 0.20, 0.25, 1].map(v => (
              <button key={v}
                onClick={() => onMaxPositionCapChange(v)}
                style={{ background: 'none', border: 'none', fontSize: 8, color: Math.abs(maxPositionCap - v) < 0.005 ? '#A78BFA' : '#1E3A5F', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700, padding: '2px 4px' }}
              >{v >= 1 ? 'OFF' : `${Math.round(v * 100)}%`}</button>
            ))}
          </div>
          {maxPositionCap < 1 && activeAssetCount * maxPositionCap < 1 - 0.01 && (
            <div style={{ fontSize: 8, color: '#EF4444', marginTop: 8, lineHeight: 1.4 }}>
              Cap × {activeAssetCount} active assets &lt; 100% — full investment may not be possible.
            </div>
          )}
        </div>

        {/* Sector caps */}
        <div style={ws.panel}>
          <SectionHeader>SECTOR CONCENTRATION CAPS</SectionHeader>
          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 10, lineHeight: 1.5 }}>
            Max portfolio weight per sector (5–100%). Paths above a cap are clipped
            and excess is shifted to other stocks and sectors when possible.
          </div>
          {sectors.map(sector => {
            const cap    = resolveSectorCap(sectorCaps, sector);
            const col    = getSectorColor(sector, sectorColors);
            const count  = assets.filter(a => a.sector === sector).length;
            const clampCap = (v) => Math.max(MIN_SECTOR_CAP, Math.min(1, v));
            return (
              <div key={sector} style={ws.capRow}>
                <div style={{ flex: '0 0 100px' }}>
                  <div style={{ fontSize: 10, color: col, fontWeight: 700 }}>{sector}</div>
                  <div style={{ fontSize: 8, color: '#334155' }}>{count} asset{count !== 1 ? 's' : ''}</div>
                </div>
                <span style={{ fontSize: 8, color: '#334155', width: 28 }}>5%</span>
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
                  type="number" min={Math.round(MIN_SECTOR_CAP * 100)} max={100} step={1}
                  value={Math.round(cap * 100)}
                  onChange={e => onSectorCapChange(sector, clampCap(parseInt(e.target.value, 10) / 100 || MIN_SECTOR_CAP))}
                  style={{ ...ws.capNumInput, borderColor: col + '44', color: col }}
                />
              </div>
            );
          })}
          {sectors.reduce((s, sector) => s + resolveSectorCap(sectorCaps, sector), 0) < 1 - 0.01 && (
            <div style={{ fontSize: 8, color: '#EF4444', marginTop: 8, lineHeight: 1.4 }}>
              Sum of sector caps &lt; 100% — excess weight cannot be fully allocated across sectors.
            </div>
          )}
        </div>

        {/* Vol theta-decay half-life */}
        <div style={ws.panel}>
          <SectionHeader>VOL THETA DECAY  ·  HALF-LIFE</SectionHeader>
          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 10, lineHeight: 1.5 }}>
            Uses 1 year of daily returns. Lower half-life emphasises recent volatility;
            higher values smooth toward the full-year average.
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 30, fontWeight: 800, color: '#F59E0B', fontVariantNumeric: 'tabular-nums' }}>
              {volHalfLife}
            </span>
            <span style={{ fontSize: 10, color: '#F59E0B', fontWeight: 700, letterSpacing: 1 }}>
              TRADING DAYS
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 8, color: '#334155', width: 44 }}>Recent</span>
            <div style={{ position: 'relative', flex: 1, height: 6, background: '#0A1628', borderRadius: 3 }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: 3,
                width: `${((volHalfLife - 5) / (126 - 5)) * 100}%`,
                background: 'linear-gradient(to right, #EF4444, #F59E0B, #10B981)',
              }} />
              <input type="range" min={5} max={126} step={1}
                value={volHalfLife}
                onChange={e => onVolHalfLifeChange(parseInt(e.target.value, 10))}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
              />
            </div>
            <span style={{ fontSize: 8, color: '#334155', width: 32, textAlign: 'right' }}>Smooth</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            {[5, 21, 63, 126].map(v => (
              <button key={v}
                onClick={() => onVolHalfLifeChange(v)}
                style={{ background: 'none', border: 'none', fontSize: 8, color: volHalfLife === v ? '#F59E0B' : '#1E3A5F', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700, padding: '2px 4px' }}
              >{v}d</button>
            ))}
          </div>
        </div>

        {/* Monte Carlo parameters */}
        <div style={ws.panel}>
          <SectionHeader>SIMULATION PARAMETERS</SectionHeader>
          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 10, lineHeight: 1.5 }}>
            Path count for analyst scenarios. All paths render as scenario optima (purple);
            robust layer subsampled to 2,500 chart points · stats use every path.
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 9, color: '#64748B', marginBottom: 6, letterSpacing: 0.8 }}>MC PATHS</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: '#00CFFD', fontVariantNumeric: 'tabular-nums' }}>
                {mcIterations.toLocaleString()}
              </span>
            </div>
            <input
              type="range"
              min={MIN_MC_ITERATIONS}
              max={MAX_MC_ITERATIONS}
              step={1000}
              value={mcIterations}
              onChange={e => onMcIterationsChange(parseInt(e.target.value, 10))}
              style={{ width: '100%', accentColor: '#00CFFD' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              {[1000, 10000, 50000, 100000].map(v => (
                <button key={v}
                  onClick={() => onMcIterationsChange(v)}
                  style={{ background: 'none', border: 'none', fontSize: 8, color: mcIterations === v ? '#00CFFD' : '#1E3A5F', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700, padding: '2px 4px' }}
                >{(v / 1000).toFixed(0)}k</button>
              ))}
            </div>
          </div>

          {/* ── Optimizer paths ──────────────────────────────────────────── */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 9, color: '#64748B', marginBottom: 6, letterSpacing: 0.8 }}>OPTIMIZER PATHS</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: '#A78BFA', fontVariantNumeric: 'tabular-nums' }}>
                {(simConfig.optimizerPaths ?? 1000).toLocaleString()}
              </span>
              <span style={{ fontSize: 9, color: '#64748B' }}>paths in robust objective</span>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              {[1000, 5000, 10000, 20000].map(v => (
                <button key={v}
                  onClick={() => onSimConfigChange({ optimizerPaths: v })}
                  style={{
                    background: (simConfig.optimizerPaths ?? 1000) === v ? '#1E1045' : 'none',
                    border: `1px solid ${(simConfig.optimizerPaths ?? 1000) === v ? '#A78BFA' : '#1E3A5F'}`,
                    borderRadius: 3, fontSize: 8, color: (simConfig.optimizerPaths ?? 1000) === v ? '#A78BFA' : '#475569',
                    cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700, padding: '3px 7px',
                  }}
                >{v >= 1000 ? `${v / 1000}k` : v}</button>
              ))}
            </div>
            <div style={{ fontSize: 8, color: '#475569', lineHeight: 1.4 }}>
              Larger = stabler weights, slower per-run. Changing this rebuilds the bank.
            </div>
          </div>

          {/* ── Scenario bank status ─────────────────────────────────────── */}
          <div style={{ marginBottom: 14, paddingTop: 10, borderTop: '1px solid #0F2337' }}>
            <div style={{ fontSize: 9, color: '#64748B', marginBottom: 8, letterSpacing: 0.8 }}>SCENARIO BANK</div>
            {bankInfo ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10B981', display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ color: '#10B981', fontWeight: 700 }}>Active</span>
                  <span style={{ color: '#475569' }}>·</span>
                  <span style={{ color: '#94A3B8' }}>{bankInfo.pathCount?.toLocaleString()} paths</span>
                  <span style={{ color: '#475569' }}>·</span>
                  <span style={{ color: '#94A3B8' }}>optimizer {bankInfo.optimizerPaths?.toLocaleString()}</span>
                  <span style={{ color: '#475569' }}>·</span>
                  <span style={{ color: '#64748B' }}>{bankInfo.builtAt}</span>
                </div>
                <button
                  onClick={onRefreshBank}
                  style={{
                    alignSelf: 'flex-start', marginTop: 4,
                    background: 'none', border: '1px solid #1E3A5F', borderRadius: 4,
                    fontSize: 8, color: '#64748B', cursor: 'pointer', fontFamily: 'monospace',
                    fontWeight: 700, padding: '4px 10px', letterSpacing: 0.5,
                  }}
                >⟳ Refresh bank</button>
              </div>
            ) : (
              <div style={{ fontSize: 8, color: '#334155', fontStyle: 'italic' }}>
                No bank yet — press REGENERATE to build one.
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 9, color: '#64748B', marginBottom: 6, letterSpacing: 0.8 }}>RISK-FREE RATE</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: '#10B981', fontVariantNumeric: 'tabular-nums' }}>
                {(riskFreeRate * 100).toFixed(2)}%
              </span>
              <span style={{ fontSize: 9, color: '#64748B' }}>BI 7-day reverse repo</span>
            </div>
            <input
              type="range"
              min={MIN_RF}
              max={MAX_RF}
              step={0.0025}
              value={riskFreeRate}
              onChange={e => onRiskFreeRateChange(parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: '#10B981' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              {[0.03, 0.0575, 0.07, 0.10].map(v => (
                <button key={v}
                  onClick={() => onRiskFreeRateChange(v)}
                  style={{ background: 'none', border: 'none', fontSize: 8, color: Math.abs(riskFreeRate - v) < 0.001 ? '#10B981' : '#1E3A5F', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700, padding: '2px 4px' }}
                >{(v * 100).toFixed(1)}%</button>
              ))}
            </div>
          </div>
        </div>

        <FactorModelPanel
          factorConfig={factorConfig}
          onFactorConfigChange={onFactorConfigChange}
        />

        {/* ── Robust optimisation config ──────────────────────────────── */}
        <RobustConfigPanel simConfig={simConfig} onSimConfigChange={onSimConfigChange} />

        {/* ── Portfolio AUM (drives IDR amounts in Analytics) ─────────── */}
        <div style={ws.panel}>
          <SectionHeader>PORTFOLIO SIZE</SectionHeader>
          <PortfolioSizeInput
            portfolioSize={factorConfig.portfolioSize ?? 0}
            onChange={v => onFactorConfigChange({ portfolioSize: v })}
          />
        </div>

        {/* ── Current holdings for rebalance ─────────────────────────── */}
        <CurrentHoldingsPanel
          activeAssets={activeAssets}
          currentWeights={currentWeights}
          onCurrentWeightsChange={onCurrentWeightsChange}
          lastRun={lastRun}
        />

        {factorConfig.useFactorModel && factorPreview?.rows?.length > 0 && (
          <div style={ws.panel}>
            <SectionHeader>FACTOR PREVIEW — ACTIVE UNIVERSE</SectionHeader>
            <div style={{ fontSize: 8, color: '#64748B', marginBottom: 8, lineHeight: 1.5 }}>
              Live estimate at mean analyst view. Updates when sliders change — no REGENERATE needed.
            </div>
            {Math.abs(factorPreview.factors?.priorExponent ?? 1) < 1e-6 && (
              <div style={{ fontSize: 8, color: '#F59E0B', marginBottom: 8, lineHeight: 1.4 }}>
                Prior is equal-weight (mcap-neutral). Move Large-cap bias toward Cap-wt to differentiate priors.
              </div>
            )}
            {factorPreview.autoLiq && (() => {
              const constrained = factorPreview.rows.filter(r => r.stressRatio != null && r.stressRatio >= 0.10);
              const warn = factorPreview.rows.filter(r => r.stressRatio != null && r.stressRatio >= 0.05 && r.stressRatio < 0.10);
              return (
                <div style={{ fontSize: 8, marginBottom: 8, lineHeight: 1.6 }}>
                  <span style={{ color: '#A78BFA', fontWeight: 700 }}>Auto-liq ON · </span>
                  <span style={{ color: '#94A3B8' }}>Penalty: </span>
                  <span style={{ color: '#00CFFD', fontWeight: 700 }}>{(factorPreview.autoLiq.liquidityPenalty * 100).toFixed(0)}%</span>
                  {constrained.length > 0 && (
                    <span style={{ color: '#EF4444' }}> · ADT-capped: {constrained.map(r => r.ticker).join(', ')}</span>
                  )}
                  {warn.length > 0 && (
                    <span style={{ color: '#F59E0B' }}> · Watch: {warn.map(r => r.ticker).join(', ')}</span>
                  )}
                </div>
              );
            })()}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ ...an.table, fontSize: 8 }}>
                <thead>
                  <tr>
                    {['Ticker', 'Prior', 'View Q', 'Ω', 'μ_BL', 'Liq', 'Mcap', 'Cap', ...(factorPreview.autoLiq ? ['Stress'] : [])].map(h => (
                      <th key={h} style={{ ...an.th, fontSize: 7 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {factorPreview.rows.map((row, i) => {
                    const stress = row.stressRatio ?? 0;
                    const capColor = stress >= 0.20 ? '#EF4444' : stress >= 0.10 ? '#F59E0B' : stress >= 0.05 ? '#FCD34D' : '#94A3B8';
                    return (
                      <tr key={row.ticker} style={{ background: i % 2 === 0 ? '#050D1A' : '#07111E' }}>
                        <td style={{ ...an.td, textAlign: 'left', fontWeight: 700 }}>{row.ticker}</td>
                        <td style={an.td}>{(row.priorWt * 100).toFixed(1)}%</td>
                        <td style={{ ...an.td, color: row.viewQ >= 0 ? '#00FF88' : '#EF4444' }}>
                          {(row.viewQ * 100).toFixed(1)}%
                        </td>
                        <td style={an.td}>{row.omega != null ? row.omega.toExponential(2) : '—'}</td>
                        <td style={{ ...an.td, color: row.muBL >= 0 ? '#00FF88' : '#EF4444' }}>
                          {(row.muBL * 100).toFixed(1)}%
                        </td>
                        <td style={an.td}>{(row.liquidityScore * 100).toFixed(0)}</td>
                        <td style={an.td}>{(row.maturityScore * 100).toFixed(0)}</td>
                        <td style={{ ...an.td, color: factorPreview.autoLiq ? capColor : '#94A3B8', fontWeight: factorPreview.autoLiq ? 700 : 400 }}>
                          {(row.effCap * 100).toFixed(1)}%
                        </td>
                        {factorPreview.autoLiq && (
                          <td style={{ ...an.td, color: capColor, fontWeight: 700 }}>
                            {stress > 0 ? (stress * 100).toFixed(0) + '%' : '—'}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {factorPreview.autoLiq && (
              <div style={{ fontSize: 7, color: '#334155', marginTop: 6, lineHeight: 1.5 }}>
                Stress = equal-weight position ÷ ADT. Cap color: <span style={{ color: '#94A3B8' }}>■</span> OK &nbsp;
                <span style={{ color: '#FCD34D' }}>■</span> watch (&gt;5%) &nbsp;
                <span style={{ color: '#F59E0B' }}>■</span> constrained (&gt;10%) &nbsp;
                <span style={{ color: '#EF4444' }}>■</span> ADT-capped (&gt;20%)
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tab 3: ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

/** Format IDR amounts compactly (input is full IDR, not millions). */
function fmtIDR(amount, { allowNegative = false } = {}) {
  if (amount == null || Number.isNaN(amount)) return '—';
  const isNeg = amount < 0;
  const abs = Math.abs(amount);
  if (abs === 0) return allowNegative ? '0' : '—';
  if (!allowNegative && amount <= 0) return '—';

  let formatted;
  if (abs >= 1e12) formatted = `${(abs / 1e12).toFixed(2)}T`;
  else if (abs >= 1e9) formatted = `${(abs / 1e9).toFixed(1)}B`;
  else if (abs >= 1e6) formatted = `${(abs / 1e6).toFixed(0)}M`;
  else formatted = abs.toLocaleString('en-US');

  return isNeg ? `−${formatted}` : formatted;
}

function buildPortfolioVariants(mvp, robustPortfolio, frontierPoints, activeTailPenalty, robustMode) {
  const variants = [];
  if (mvp?.weights) {
    variants.push({
      id: 'min-var',
      label: 'Min Variance',
      color: '#00CFFD',
      icon: '◆',
      portfolio: mvp,
      scenarioStats: null,
    });
  }

  if (robustMode === 'avgMuSharpe') {
    if (robustPortfolio?.weights) {
      variants.push({
        id: 'robust',
        label: 'Robust',
        color: '#FFD700',
        icon: '★',
        portfolio: robustPortfolio,
        scenarioStats: robustPortfolio.scenarioStats ?? null,
        isActiveRun: true,
      });
    }
    return variants;
  }

  for (const fp of frontierPoints ?? []) {
    const lam = fp.lambda;
    variants.push({
      id: `lambda-${lam}`,
      label: lam === 0 ? 'Robust λ=0' : `Robust λ=${lam.toFixed(2)}`,
      color: '#FFD700',
      icon: '★',
      portfolio: {
        weights: fp.weights,
        portfolioReturn: fp.portfolioReturn,
        portfolioRisk: fp.portfolioRisk,
        portfolioSharpe: fp.portfolioSharpe,
      },
      scenarioStats: fp.scenarioStats ?? null,
      lambda: lam,
      isActiveRun: Math.abs(lam - activeTailPenalty) < 0.03,
    });
  }
  return variants;
}

function AnalyticsTab({ lastRun, simError, riskFreeRate, sectorColors, benchmark, factorConfig }) {
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

  const { simResult, covMatrix, simCov, activeAssets, meta, currentWeightsFractions, corrStart, corrEnd } = lastRun;

  if (!simResult) {
    return (
      <div style={an.empty}>
        <div style={{ color: '#EF4444', fontWeight: 700 }}>Analytics data incomplete</div>
        <p style={{ color: '#94A3B8', margin: 0 }}>Click REGENERATE.</p>
      </div>
    );
  }

  const { bestSharpePortfolio: bsp, minVariancePortfolio: mvp, robustPortfolio, frontierPoints } = simResult;
  const robust = robustPortfolio;
  const best = bsp;

  if (!robust?.weights || !best?.weights || !mvp?.weights || activeAssets.length < 2) {
    return (
      <div style={an.empty}>
        <div style={{ color: '#EF4444', fontWeight: 700 }}>Invalid simulation output</div>
        <p style={{ color: '#94A3B8', margin: 0 }}>Click REGENERATE again.</p>
      </div>
    );
  }

  const n = activeAssets.length;
  if (robust.weights.length !== n || best.weights.length !== n || mvp.weights.length !== n || covMatrix.length !== n) {
    return (
      <div style={an.empty}>
        <div style={{ color: '#EF4444', fontWeight: 700 }}>Data size mismatch</div>
        <p style={{ color: '#94A3B8', margin: 0 }}>REGENERATE to refresh analytics.</p>
      </div>
    );
  }

  return (
    <AnalyticsTabContent
      lastRun={lastRun}
      covMatrix={covMatrix}
      simCov={simCov}
      activeAssets={activeAssets}
      meta={meta}
      currentWeightsFractions={currentWeightsFractions}
      corrStart={corrStart}
      corrEnd={corrEnd}
      riskFreeRate={riskFreeRate}
      sectorColors={sectorColors}
      benchmark={benchmark}
      factorConfig={factorConfig}
      mvp={mvp}
      best={best}
      robust={robust}
      frontierPoints={frontierPoints}
    />
  );
}

function AnalyticsTabContent({
  lastRun,
  covMatrix,
  simCov,
  activeAssets,
  meta,
  currentWeightsFractions,
  corrStart,
  corrEnd,
  riskFreeRate,
  sectorColors,
  benchmark,
  factorConfig,
  mvp,
  best,
  robust,
  frontierPoints,
}) {
  const [selectedVariantId, setSelectedVariantId] = useState(null);
  const portfolioSize = factorConfig?.portfolioSize ?? 0;
  const riskCov = simCov ?? covMatrix;
  const n = activeAssets.length;

  const sc = meta?.simConfig ?? {};
  const activeTail = sc.tailPenalty ?? DEFAULT_TAIL_PENALTY;
  const isLegacyRobust = sc.robustMode === 'avgMuSharpe';
  const variants = useMemo(
    () => buildPortfolioVariants(mvp, robust, frontierPoints, activeTail, sc.robustMode),
    [mvp, robust, frontierPoints, activeTail, sc.robustMode],
  );

  useEffect(() => {
    if (!variants.length) return;
    const activeLambda = variants.find(v => v.isActiveRun);
    setSelectedVariantId(activeLambda?.id ?? variants[0]?.id ?? null);
  }, [lastRun?.meta?.ts, variants]);

  const selected = variants.find(v => v.id === selectedVariantId) ?? variants[0];
  const selWeights = selected?.portfolio?.weights ?? robust.weights;
  const selRC = computeRiskContributions(selWeights, riskCov);
  const selStress = useMemo(
    () => evaluateStressScenarios(activeAssets, selWeights),
    [activeAssets, selWeights],
  );

  const bestRC = computeRiskContributions(best.weights, riskCov);
  const eqW = Array(n).fill(1 / n);
  const eqRC = computeRiskContributions(eqW, riskCov);

  const volHalfLife = meta?.volHalfLife ?? DEFAULT_VOL_HALF_LIFE;
  const annVols = activeAssets.map(a => resolveDailyVol(a, volHalfLife) * SQRT_252);
  const pertMeans = activeAssets.map(a => consensusTotalUpside(a));

  const bmMetrics = benchmark && corrStart && corrEnd
    ? computeBenchmarkMetrics(activeAssets, selWeights, benchmark.priceHistory, corrStart, corrEnd)
    : null;

  const trades = currentWeightsFractions
    ? buildRebalanceTrades(activeAssets, selWeights, currentWeightsFractions)
    : null;
  const oneWayTurnover = trades ? computeTurnover(selWeights, currentWeightsFractions) : null;

  const sortedWeightIndices = activeAssets
    .map((a, i) => ({ a, i, w: selWeights[i] ?? 0 }))
    .sort((x, y) => y.w - x.w);

  return (
    <div style={an.layout}>

      {/* ── Portfolio explorer (variant toggle + metrics + weights) ───── */}
      <div style={an.panel}>
        <SectionHeader>PORTFOLIO EXPLORER</SectionHeader>
        <div style={{ fontSize: 8, color: '#64748B', marginBottom: 10, lineHeight: 1.5 }}>
          {isLegacyRobust
            ? <>Legacy mean-μ Sharpe run — toggle between <strong style={{ color: '#00CFFD' }}>Min Variance</strong> and <strong style={{ color: '#FFD700' }}>Robust</strong>.</>
            : <>Compare implementable portfolios from the same run. Toggle λ or min-variance below.</>}
          {portfolioSize > 0
            ? <> AUM: <span style={{ color: '#00CFFD', fontWeight: 700 }}>{fmtIDR(portfolioSize)} IDR</span> — amounts shown per line.</>
            : <> Set <strong style={{ color: '#94A3B8' }}>Portfolio size</strong> in Workspace to see IDR allocations.</>}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 14 }}>
          {variants.map(v => {
            const active = selectedVariantId === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setSelectedVariantId(v.id)}
                style={{
                  background: active ? `${v.color}18` : '#050D1A',
                  border: `1px solid ${active ? v.color : '#1E3A5F'}`,
                  borderRadius: 4,
                  color: active ? v.color : '#64748B',
                  fontSize: 8,
                  fontWeight: active ? 700 : 500,
                  padding: '5px 8px',
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                  whiteSpace: 'nowrap',
                }}
              >
                {v.icon} {v.label}{v.isActiveRun ? ' · run' : ''}
              </button>
            );
          })}
        </div>

        {selected && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: portfolioSize > 0 ? '1fr 1fr' : '1fr', gap: 12, marginBottom: 14 }}>
              <PortfolioSummaryCard
                title={selected.label.toUpperCase()}
                icon={selected.icon}
                color={selected.color}
                portfolio={selected.portfolio}
                riskFreeRate={riskFreeRate}
                sharpeLabel="Sharpe (excess/σ)"
                scenarioStats={selected.scenarioStats}
                benchmarkMetrics={bmMetrics}
                portfolioSize={portfolioSize}
              />
              {portfolioSize > 0 && (
                <div style={{ background: '#050D1A', border: '1px solid #0F2337', borderRadius: 8, padding: '14px 16px' }}>
                  <div style={{ fontSize: 9, color: '#64748B', fontWeight: 700, letterSpacing: 1, marginBottom: 10 }}>AUM ALLOCATION</div>
                  {[['Total AUM', portfolioSize, '#E2E8F0'],
                    ['Expected μ (1yr)', portfolioSize * (selected.portfolio.portfolioReturn ?? 0), '#00FF88'],
                    ['σ notional (1yr)', portfolioSize * (selected.portfolio.portfolioRisk ?? 0), '#00CFFD'],
                  ].map(([k, v, c]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                      <span style={{ fontSize: 9, color: '#475569' }}>{k}</span>
                      <span style={{ fontSize: 11, color: c, fontWeight: 800 }}>{fmtIDR(v)} IDR</span>
                    </div>
                  ))}
                  {selected.scenarioStats && (
                    <>
                      <div style={{ borderTop: '1px solid #0A1628', margin: '8px 0' }} />
                      {[['P10 return', portfolioSize * selected.scenarioStats.returnP10, '#94A3B8'],
                        ['P90 return', portfolioSize * selected.scenarioStats.returnP90, '#94A3B8'],
                        ['CVaR 5% loss', portfolioSize * selected.scenarioStats.cvar5, '#EF4444'],
                      ].map(([k, v, c]) => (
                        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                          <span style={{ fontSize: 9, color: '#475569' }}>{k}</span>
                          <span style={{ fontSize: 11, color: c, fontWeight: 800 }}>{fmtIDR(v, { allowNegative: true })} IDR</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Weights for selected variant */}
            <div style={{ fontSize: 9, color: selected.color, fontWeight: 700, marginBottom: 8, letterSpacing: 1 }}>
              {selected.icon} ALLOCATION — {selected.label}
            </div>
            {sortedWeightIndices.map(({ a, i, w }) => (
              <WeightBar
                key={a.ticker}
                ticker={a.ticker}
                sector={a.sector}
                weight={w}
                rcFrac={selRC[i] ?? 0}
                sectorColors={sectorColors}
                portfolioSize={portfolioSize}
              />
            ))}
          </>
        )}
      </div>

      {/* ── Sector weights vs caps (selected book) ─────────────────────── */}
      {meta?.sectorCaps && selected && (
        <div style={an.panel}>
          <SectionHeader>SECTOR WEIGHTS vs CAPS — {selected.label.toUpperCase()}</SectionHeader>
          <table style={an.table}>
            <thead>
              <tr>
                {['Sector', 'Weight', portfolioSize > 0 ? 'IDR' : null, 'Cap', 'Headroom'].filter(Boolean).map(h => (
                  <th key={h} style={{ ...an.th, textAlign: h === 'Sector' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(computeSectorWeights(selWeights, activeAssets))
                .sort((a, b) => b[1] - a[1])
                .map(([sector, wt], idx) => {
                  const cap = resolveSectorCap(meta.sectorCaps, sector);
                  const headroom = cap - wt;
                  const col = getSectorColor(sector, sectorColors);
                  const over = wt > cap + 0.001;
                  return (
                    <tr key={sector} style={{ background: idx % 2 === 0 ? '#050D1A' : '#07111E' }}>
                      <td style={{ ...an.td, textAlign: 'left', color: col, fontWeight: 700 }}>{sector}</td>
                      <td style={{ ...an.td, color: over ? '#EF4444' : '#E2E8F0', fontWeight: over ? 700 : 400 }}>
                        {(wt * 100).toFixed(1)}%
                      </td>
                      {portfolioSize > 0 && (
                        <td style={{ ...an.td, color: '#94A3B8' }}>{fmtIDR(wt * portfolioSize)}</td>
                      )}
                      <td style={an.td}>{(cap * 100).toFixed(0)}%</td>
                      <td style={{ ...an.td, color: headroom < 0.01 ? '#F59E0B' : '#64748B' }}>
                        {(headroom * 100).toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Stress tests (selected book) ──────────────────────────────── */}
      {selStress?.length > 0 && selected && (
        <div style={an.panel}>
          <SectionHeader>STRESS TESTS — {selected.label.toUpperCase()}</SectionHeader>
          <table style={an.table}>
            <thead>
              <tr>
                {['Scenario', 'Return', portfolioSize > 0 ? 'IDR (1yr)' : null, 'vs All Mean'].filter(Boolean).map(h => (
                  <th key={h} style={{ ...an.th, textAlign: h === 'Scenario' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {selStress.map((s, idx) => {
                const isBull = s.name.includes('High');
                const isBear = s.name.includes('Low') || s.name.includes('Stress');
                return (
                  <tr key={s.name} style={{ background: idx % 2 === 0 ? '#050D1A' : '#07111E' }}>
                    <td style={{ ...an.td, textAlign: 'left', color: isBull ? '#00FF88' : isBear ? '#EF4444' : '#94A3B8', fontWeight: 700 }}>
                      {s.name}
                    </td>
                    <td style={{ ...an.td, color: s.portfolioReturn >= 0 ? '#00FF88' : '#EF4444', fontWeight: 700 }}>
                      {s.portfolioReturn >= 0 ? '+' : ''}{(s.portfolioReturn * 100).toFixed(1)}%
                    </td>
                    {portfolioSize > 0 && (
                      <td style={{ ...an.td, color: s.portfolioReturn >= 0 ? '#00FF88' : '#EF4444' }}>
                        {fmtIDR(portfolioSize * s.portfolioReturn, { allowNegative: true })} IDR
                      </td>
                    )}
                    <td style={{ ...an.td, color: s.vsMean >= 0 ? '#10B981' : '#EF4444' }}>
                      {s.vsMean >= 0 ? '+' : ''}{(s.vsMean * 100).toFixed(1)}pp
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Rebalance to selected book ────────────────────────────────── */}
      {trades && selected && (
        <div style={an.panel}>
          <SectionHeader>REBALANCE TO {selected.label.toUpperCase()}</SectionHeader>
          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 8, lineHeight: 1.5 }}>
            From current holdings to selected portfolio. One-way turnover:{' '}
            <span style={{ color: selected.color, fontWeight: 700 }}>{(oneWayTurnover * 100).toFixed(1)}%</span>
            {portfolioSize > 0 && (
              <> · trade volume ≈ <span style={{ color: '#FFD700', fontWeight: 700 }}>{fmtIDR(oneWayTurnover * portfolioSize)} IDR</span></>
            )}
          </div>
          <table style={an.table}>
            <thead>
              <tr>
                {['Ticker', 'Current', portfolioSize > 0 ? 'Current IDR' : null, 'Target', portfolioSize > 0 ? 'Target IDR' : null, 'Δ', portfolioSize > 0 ? 'Trade IDR' : null, 'Trade'].filter(Boolean).map(h => (
                  <th key={h} style={{ ...an.th, textAlign: h === 'Ticker' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t, idx) => {
                const col = getSectorColor(t.sector, sectorColors);
                const tradeColor = t.trade === 'BUY' ? '#00FF88' : t.trade === 'SELL' ? '#EF4444' : '#475569';
                return (
                  <tr key={t.ticker} style={{ background: idx % 2 === 0 ? '#050D1A' : '#07111E' }}>
                    <td style={{ ...an.td, textAlign: 'left', color: col, fontWeight: 700 }}>{t.ticker}</td>
                    <td style={an.td}>{(t.current * 100).toFixed(1)}%</td>
                    {portfolioSize > 0 && <td style={{ ...an.td, color: '#64748B' }}>{fmtIDR(t.current * portfolioSize)}</td>}
                    <td style={an.td}>{(t.target * 100).toFixed(1)}%</td>
                    {portfolioSize > 0 && <td style={{ ...an.td, color: selected.color }}>{fmtIDR(t.target * portfolioSize)}</td>}
                    <td style={{ ...an.td, color: t.delta > 0.001 ? '#00FF88' : t.delta < -0.001 ? '#EF4444' : '#475569' }}>
                      {t.delta >= 0 ? '+' : ''}{(t.delta * 100).toFixed(1)}pp
                    </td>
                    {portfolioSize > 0 && (
                      <td style={{ ...an.td, color: tradeColor, fontWeight: 700 }}>
                        {t.trade === 'HOLD' ? '—' : (t.delta > 0 ? '+' : '') + fmtIDR(t.delta * portfolioSize, { allowNegative: true })}
                      </td>
                    )}
                    <td style={{ ...an.td, color: tradeColor, fontWeight: 700 }}>{t.trade}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── λ metrics comparison (tail-aware runs only) ───────────────── */}
      {!isLegacyRobust && frontierPoints?.length > 0 && frontierPoints[0]?.scenarioStats && (
        <div style={an.panel}>
          <SectionHeader>λ METRICS COMPARISON</SectionHeader>
          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 8, lineHeight: 1.5 }}>
            All λ levels on the same MC cloud. Click a row&apos;s λ in Portfolio Explorer above to inspect weights.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={an.table}>
              <thead>
                <tr>
                  {['λ', 'μ (ann)', 'σ (ann)', 'Sharpe', 'P10', 'P50', 'P90', 'CVaR 5%', 'Tail gap', 'P(r<rf)'].map(h => (
                    <th key={h} style={an.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {frontierPoints.map((fp, idx) => {
                  const isSel = selected?.lambda != null && Math.abs(fp.lambda - selected.lambda) < 1e-8;
                  const isMinVar = selected?.id === 'min-var';
                  const ss = fp.scenarioStats;
                  const rowBg = isSel && !isMinVar ? '#130F00' : idx % 2 === 0 ? '#050D1A' : '#07111E';
                  return (
                    <tr
                      key={fp.lambda}
                      style={{ background: rowBg, outline: isSel && !isMinVar ? '1px solid #FFD70044' : 'none', cursor: 'pointer' }}
                      onClick={() => setSelectedVariantId(`lambda-${fp.lambda}`)}
                    >
                      <td style={{ ...an.td, color: isSel && !isMinVar ? '#FFD700' : '#94A3B8', fontWeight: isSel && !isMinVar ? 700 : 400 }}>
                        {fp.lambda.toFixed(2)}
                      </td>
                      <td style={{ ...an.td, color: '#00FF88' }}>
                        {fp.portfolioReturn != null ? `${(fp.portfolioReturn * 100 >= 0 ? '+' : '')}${(fp.portfolioReturn * 100).toFixed(1)}%` : '—'}
                      </td>
                      <td style={{ ...an.td, color: '#00CFFD' }}>
                        {fp.portfolioRisk != null ? `${(fp.portfolioRisk * 100).toFixed(1)}%` : '—'}
                      </td>
                      <td style={{ ...an.td, fontWeight: 700, color: fp.portfolioSharpe > 1 ? '#FFD700' : fp.portfolioSharpe > 0.5 ? '#F59E0B' : '#EF4444' }}>
                        {fp.portfolioSharpe != null ? fp.portfolioSharpe.toFixed(3) : '—'}
                      </td>
                      {ss ? (
                        <>
                          <td style={{ ...an.td, color: '#94A3B8' }}>{(ss.returnP10 * 100).toFixed(1)}%</td>
                          <td style={{ ...an.td, color: '#94A3B8' }}>{(ss.returnP50 * 100).toFixed(1)}%</td>
                          <td style={{ ...an.td, color: '#94A3B8' }}>{(ss.returnP90 * 100).toFixed(1)}%</td>
                          <td style={{ ...an.td, color: '#EF4444' }}>{(ss.cvar5 * 100).toFixed(1)}%</td>
                          <td style={{ ...an.td, color: ss.tailGap > 0.15 ? '#EF4444' : ss.tailGap > 0.08 ? '#F59E0B' : '#10B981' }}>
                            {(ss.tailGap * 100).toFixed(1)}pp
                          </td>
                          <td style={{ ...an.td, color: ss.probBelowRf > 0.40 ? '#EF4444' : ss.probBelowRf > 0.20 ? '#F59E0B' : '#10B981' }}>
                            {(ss.probBelowRf * 100).toFixed(1)}%
                          </td>
                        </>
                      ) : Array.from({ length: 6 }, (_, k) => <td key={k} style={an.td}>—</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Asset metrics table ───────────────────────────────────────── */}
      <div style={an.panel}>
        <SectionHeader>PER-ASSET METRICS</SectionHeader>
        <div style={{ overflowX: 'auto' }}>
          <table style={an.table}>
            <thead>
              <tr>
                {['Asset', 'Sector', 'σ ann', 'E[r]', 'Selected wt', portfolioSize > 0 ? 'Selected IDR' : null, 'Sel. RC', 'Best wt', 'MVP wt', 'EW RC'].filter(Boolean).map(h => (
                  <th key={h} style={an.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeAssets.map((a, i) => {
                const col = getSectorColor(a.sector, sectorColors);
                const sw = selWeights[i] ?? 0;
                return (
                  <tr key={a.ticker} style={{ background: i % 2 === 0 ? '#050D1A' : '#07111E' }}>
                    <td style={{ ...an.td, color: col, fontWeight: 700 }}>{a.ticker}</td>
                    <td style={{ ...an.td, color: '#475569' }}>{a.sector}</td>
                    <td style={{ ...an.td, color: '#F59E0B' }}>{(annVols[i] * 100).toFixed(1)}%</td>
                    <td style={{ ...an.td, color: pertMeans[i] >= 0 ? '#00FF88' : '#EF4444' }}>
                      {(pertMeans[i] * 100) >= 0 ? '+' : ''}{(pertMeans[i] * 100).toFixed(1)}%
                    </td>
                    <td style={{ ...an.td, color: selected?.color ?? '#FFD700' }}>{(sw * 100).toFixed(1)}%</td>
                    {portfolioSize > 0 && (
                      <td style={{ ...an.td, color: '#94A3B8' }}>{fmtIDR(sw * portfolioSize)}</td>
                    )}
                    <td style={{ ...an.td, color: `${selected?.color ?? '#FFD700'}88` }}>{formatRiskContributionPct(selRC[i])}</td>
                    <td style={{ ...an.td, color: '#FF2D6F' }}>{((best.weights[i] ?? 0) * 100).toFixed(1)}%</td>
                    <td style={{ ...an.td, color: '#00CFFD' }}>{((mvp.weights[i] ?? 0) * 100).toFixed(1)}%</td>
                    <td style={{ ...an.td, color: '#64748B' }}>{formatRiskContributionPct(eqRC[i])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Robust optimisation config panel
// ─────────────────────────────────────────────────────────────────────────────

function RobustConfigPanel({ simConfig, onSimConfigChange }) {
  const sc = simConfig;
  return (
    <div style={ws.panel}>
      <SectionHeader>ROBUST OPTIMISATION</SectionHeader>
      <div style={{ fontSize: 8, color: '#64748B', marginBottom: 10, lineHeight: 1.5 }}>
        Controls how the Robust Portfolio is optimised. Tail-aware mode penalises left-tail risk
        (CVaR gap) so the optimizer avoids high-mean/high-tail portfolios.
      </div>

      {/* Mode select */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: '#94A3B8', fontWeight: 700, marginBottom: 6 }}>Objective mode</div>
        {[
          { val: 'tailAware',   label: 'Tail-aware (recommended)' },
          { val: 'avgMuSharpe', label: 'Mean-μ Sharpe (legacy)' },
        ].map(({ val, label }) => (
          <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={sc.robustMode === val}
              onChange={() => onSimConfigChange({ robustMode: val })}
            />
            <span style={{ fontSize: 9, color: sc.robustMode === val ? '#00CFFD' : '#64748B', fontWeight: sc.robustMode === val ? 700 : 400 }}>
              {label}
            </span>
          </label>
        ))}
      </div>

      {/* Tail penalty λ */}
      {sc.robustMode === 'tailAware' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 9, color: '#94A3B8', fontWeight: 700 }}>Tail penalty λ</span>
            <span style={{ fontSize: 9, color: '#FF2D6F', fontWeight: 700 }}>{sc.tailPenalty.toFixed(2)}</span>
          </div>
          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 4, lineHeight: 1.4 }}>
            Penalises (mean return − CVaR₅%) / σ_ref. 0 = pure Sharpe. Default 0.10 = light tail cushion.
          </div>
          <input
            type="range" min={0} max={1} step={0.05}
            value={sc.tailPenalty}
            onChange={e => onSimConfigChange({ tailPenalty: parseFloat(e.target.value) })}
            style={{ width: '100%', accentColor: '#FF2D6F' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, flexWrap: 'wrap', gap: 2 }}>
            {[[0,'Pure Sharpe'],[0.10,'Default'],[0.20,'Moderate'],[0.35,'Heavy'],[0.75,'Max protect']].map(([v, l]) => (
              <button key={l} onClick={() => onSimConfigChange({ tailPenalty: v })}
                style={{ background: 'none', border: 'none', fontSize: 7, color: Math.abs(sc.tailPenalty - v) < 0.03 ? '#FF2D6F' : '#1E3A5F', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700, padding: '2px 3px' }}
              >{l}</button>
            ))}
          </div>
        </div>
      )}

      {/* Σ shrinkage */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={sc.shrinkage}
          onChange={e => onSimConfigChange({ shrinkage: e.target.checked })}
        />
        <div>
          <div style={{ fontSize: 9, color: '#E2E8F0', fontWeight: 700 }}>Ledoit-Wolf Σ shrinkage</div>
          <div style={{ fontSize: 8, color: '#64748B', lineHeight: 1.4 }}>
            Reduces overfitting when assets ≫ history length. Recommended ON.
          </div>
        </div>
      </label>

      {/* Deterministic solver starts */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={sc.deterministicStarts ?? true}
          onChange={e => onSimConfigChange({ deterministicStarts: e.target.checked })}
        />
        <div>
          <div style={{ fontSize: 9, color: '#E2E8F0', fontWeight: 700 }}>Deterministic solver starts</div>
          <div style={{ fontSize: 8, color: '#64748B', lineHeight: 1.4 }}>
            Uses tangency + equal-weight + min-var + per-asset cap corners + per-sector cap corners
            instead of random Dirichlet restarts. Recommended ON with bank (gives ~0 pp weight jitter).
          </div>
        </div>
      </label>

      {/* Turnover penalty κ — shown only when holdings have been entered */}
      <div style={{ marginBottom: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: '#94A3B8', fontWeight: 700 }}>Turnover penalty κ</span>
          <span style={{ fontSize: 9, color: '#A78BFA', fontWeight: 700 }}>{sc.turnoverPenalty.toFixed(2)}</span>
        </div>
        <div style={{ fontSize: 8, color: '#64748B', marginBottom: 4, lineHeight: 1.4 }}>
          Penalises deviation from current holdings (enter holdings below). 0 = free rebalance.
        </div>
        <input
          type="range" min={0} max={0.5} step={0.025}
          value={sc.turnoverPenalty}
          onChange={e => onSimConfigChange({ turnoverPenalty: parseFloat(e.target.value) })}
          style={{ width: '100%', accentColor: '#A78BFA' }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Current holdings panel
// ─────────────────────────────────────────────────────────────────────────────

function CurrentHoldingsPanel({ activeAssets, currentWeights, onCurrentWeightsChange, lastRun }) {
  const [open, setOpen] = useState(false);

  const totalPct = activeAssets.reduce((s, a) => s + (parseFloat(currentWeights[a.ticker]) || 0), 0);
  const sumOk = Math.abs(totalPct - 100) < 0.5;
  const anyWeight = activeAssets.some(a => (currentWeights[a.ticker] ?? 0) > 0);

  const handleNorm = () => {
    if (totalPct === 0) return;
    const next = {};
    activeAssets.forEach(a => {
      next[a.ticker] = +(((parseFloat(currentWeights[a.ticker]) || 0) / totalPct) * 100).toFixed(2);
    });
    onCurrentWeightsChange(next);
  };

  const handleClear = () => onCurrentWeightsChange({});

  const handleEW = () => {
    const eq = +(100 / activeAssets.length).toFixed(2);
    const next = {};
    activeAssets.forEach(a => { next[a.ticker] = eq; });
    onCurrentWeightsChange(next);
  };

  return (
    <div style={ws.panel}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
      >
        <SectionHeader>CURRENT HOLDINGS {anyWeight && <span style={{ color: '#10B981' }}>●</span>}</SectionHeader>
        <span style={{ fontSize: 10, color: '#334155', marginTop: -10 }}>{open ? '▲' : '▼'}</span>
      </div>
      {!open && (
        <div style={{ fontSize: 8, color: '#64748B', lineHeight: 1.5 }}>
          Enter current portfolio weights for rebalance view and turnover penalty. Click to expand.
        </div>
      )}
      {open && (
        <>
          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 8, lineHeight: 1.5 }}>
            Enter current % weights. Re-REGENERATE to apply turnover penalty. Rebalance table appears in Analytics.
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button style={{ ...ws.capNumInput, cursor: 'pointer', padding: '3px 8px', fontSize: 8 }} onClick={handleEW}>EW</button>
            <button style={{ ...ws.capNumInput, cursor: 'pointer', padding: '3px 8px', fontSize: 8 }} onClick={handleNorm}>NORM</button>
            <button style={{ ...ws.capNumInput, cursor: 'pointer', padding: '3px 8px', fontSize: 8 }} onClick={handleClear}>CLEAR</button>
            <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, color: sumOk ? '#00FF88' : anyWeight ? '#EF4444' : '#334155', fontVariantNumeric: 'tabular-nums' }}>
              {totalPct.toFixed(1)}%
            </span>
          </div>
          {activeAssets.map(a => {
            const val = currentWeights[a.ticker] ?? '';
            const col = getSectorColor(a.sector, {});
            return (
              <div key={a.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 50, fontSize: 10, color: '#64748B', fontWeight: 700 }}>{a.ticker}</span>
                <div style={{ flex: 1, height: 4, background: '#0A1628', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(parseFloat(val) || 0, 100)}%`, background: '#A78BFA', opacity: 0.6 }} />
                </div>
                <input
                  type="number" min={0} max={100} step={0.1}
                  value={val}
                  placeholder="0"
                  onChange={e => onCurrentWeightsChange(prev => ({ ...prev, [a.ticker]: parseFloat(e.target.value) || 0 }))}
                  style={{ ...ws.capNumInput, width: 52, color: '#A78BFA', borderColor: '#A78BFA44' }}
                />
                <span style={{ fontSize: 9, color: '#334155' }}>%</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function FactorModelPanel({ factorConfig, onFactorConfigChange }) {
  const fc = factorConfig;
  const set = (patch) => onFactorConfigChange({ ...fc, ...patch });
  const pct = (v) => `${Math.round(v * 100)}%`;
  const strengthSlider = (key, label, desc, scaleNote, color = '#A78BFA') => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 9, color: '#94A3B8', fontWeight: 700 }}>{label}</span>
        <span style={{ fontSize: 9, color, fontWeight: 700 }}>{pct(fc[key])}</span>
      </div>
      <div style={{ fontSize: 8, color: '#64748B', marginBottom: 4, lineHeight: 1.4 }}>{desc}</div>
      <input
        type="range" min={0} max={1} step={0.05}
        value={fc[key]}
        onChange={e => set({ [key]: parseFloat(e.target.value) })}
        style={{ width: '100%', accentColor: color }}
      />
      <div style={{ fontSize: 7, color: '#475569', marginTop: 4, lineHeight: 1.4 }}>
        Scales as: {scaleNote}
      </div>
    </div>
  );

  return (
    <div style={ws.panel}>
      <SectionHeader>BLACK-LITTERMAN &amp; RISK FACTORS</SectionHeader>

      <FactorToggle
        label="Enable factor model"
        checked={fc.useFactorModel}
        onChange={v => set({ useFactorModel: v })}
        desc="Turns on BL returns, liquidity-adjusted Σ, and ADT caps. Off = legacy PERT-only behavior."
        scaleNote="Boolean — no partial effect."
      />

      {fc.useFactorModel && (
        <>
          <div style={{ fontSize: 8, color: '#334155', letterSpacing: 1, fontWeight: 700, margin: '12px 0 8px' }}>
            RETURNS (BLACK-LITTERMAN)
          </div>

          <FactorToggle
            label="Cap-weight prior"
            checked={fc.useCapPrior}
            onChange={v => set({ useCapPrior: v })}
            desc="Builds equilibrium π from market caps (with large-cap bias slider)."
            scaleNote="Off → equal-weight prior regardless of bias slider."
          />
          <FactorToggle
            label="Analyst target views"
            checked={fc.useAnalystViews}
            onChange={v => set({ useAnalystViews: v })}
            desc="Uses analyst price targets as BL views Q."
            scaleNote="Off → posterior μ = prior π for all assets."
          />

          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: '#94A3B8', fontWeight: 700 }}>τ — Prior anchor strength</span>
              <span style={{ fontSize: 9, color: '#00CFFD', fontWeight: 700 }}>{fc.tau.toFixed(3)}</span>
            </div>
            <div style={{ fontSize: 8, color: '#64748B', marginBottom: 4, lineHeight: 1.4 }}>
              Controls the π-vs-Q blend. Lower → μ anchors toward cap-weight equilibrium π (skeptical of analysts). Higher → μ follows analyst targets Q more closely.
            </div>
            <input
              type="range" min={MIN_TAU} max={MAX_TAU} step={0.005}
              value={fc.tau}
              onChange={e => set({ tau: parseFloat(e.target.value) })}
              style={{ width: '100%', accentColor: '#00CFFD' }}
            />
            <div style={{ fontSize: 7, color: '#475569', marginTop: 4, lineHeight: 1.4 }}>
              τ ∈ [{MIN_TAU}, {MAX_TAU}]. IDX default 0.030 — sell-side targets average ~50pp above equilibrium; moderate skepticism is appropriate.
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              {[[MIN_TAU, 'Cap anchor'], [0.03, 'IDX default'], [0.07, 'Balanced'], [MAX_TAU, 'Trust analysts']].map(([v, label]) => (
                <button key={label} onClick={() => set({ tau: v })}
                  style={{ background: 'none', border: 'none', fontSize: 7, color: Math.abs(fc.tau - v) < 0.006 ? '#00CFFD' : '#1E3A5F', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700, padding: '2px 3px' }}
                >{label}</button>
              ))}
            </div>
          </div>

          {strengthSlider('analystConfidence', 'Analyst confidence', 'Low analyst count reduces trust in target prices.', 'Exponent on (maxAnalysts / count). 0% = ignore; 100% ≈ 8× Ω gap for BIRD vs BBCA.')}
          {strengthSlider('dispersionOmega', 'Dispersion → Ω', 'Wide target range reduces trust in consensus.', 'Multiplier on (1 + dispersion)² inside Ω. 0% = range ignored.')}

          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: '#94A3B8', fontWeight: 700 }}>Large-cap bias</span>
              <span style={{ fontSize: 9, color: '#10B981', fontWeight: 700 }}>{pct(fc.largeCapBias)}</span>
            </div>
            <div style={{ fontSize: 8, color: '#64748B', marginBottom: 4, lineHeight: 1.4 }}>
              Tilts BL equilibrium prior toward large / mature businesses.
            </div>
            <input
              type="range" min={0} max={1} step={0.05}
              value={fc.largeCapBias}
              onChange={e => set({ largeCapBias: parseFloat(e.target.value) })}
              style={{ width: '100%', accentColor: '#10B981' }}
            />
            <div style={{ fontSize: 7, color: '#475569', marginTop: 4, lineHeight: 1.4 }}>
              Scales as: prior wt ∝ marketCap^(1 − 2×bias). 0% = cap-weight · 50% = equal · 100% = small-cap tilt.
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              {[[0, 'Cap-wt'], [0.25, 'Favor large'], [0.5, 'Equal'], [1, 'Small-cap']].map(([v, label]) => (
                <button key={label} onClick={() => set({ largeCapBias: v })}
                  style={{ background: 'none', border: 'none', fontSize: 7, color: Math.abs(fc.largeCapBias - v) < 0.03 ? '#10B981' : '#1E3A5F', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700, padding: '2px 3px' }}
                >{label}</button>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 8, color: '#334155', letterSpacing: 1, fontWeight: 700, margin: '12px 0 8px' }}>
            RISK (BEYOND PRICE σ)
          </div>

          <FactorToggle
            label="Liquidity risk on Σ"
            checked={fc.useLiquidityRisk}
            onChange={v => set({ useLiquidityRisk: v })}
            desc="Penalizes illiquid stocks beyond price volatility."
            scaleNote="Penalty strength from AUM vs ADT; per-stock inflation from liquidity score."
          />

          <div style={{ fontSize: 8, color: '#64748B', marginBottom: 8, lineHeight: 1.4 }}>
            Portfolio size is set in the <strong style={{ color: '#94A3B8' }}>PORTFOLIO SIZE</strong> panel above.
            Re-REGENERATE after changing AUM to refresh liquidity caps.
          </div>
        </>
      )}
    </div>
  );
}

function PortfolioSizeInput({ portfolioSize, onChange }) {
  const displayVal = portfolioSize > 0 ? Math.round(portfolioSize / 1e6) : '';

  const handleChange = e => {
    const raw = parseFloat(e.target.value.replace(/,/g, '')) || 0;
    onChange(raw * 1e6);
  };

  const presets = [
    [1_000, '1,000M'],
    [10_000, '10,000M'],
    [100_000, '100,000M'],
    [500_000, '500,000M'],
    [1_000_000, '1,000,000M'],
  ];

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 8, color: '#94A3B8', fontWeight: 700 }}>Portfolio size (million IDR)</span>
      </div>

      <input
        type="number" min={0} step={1000}
        value={displayVal}
        onChange={handleChange}
        placeholder="100000 (= 100,000 million IDR)"
        style={{ width: '100%', background: '#050D1A', border: '1px solid #0F2337', borderRadius: 4, color: '#E2E8F0', fontSize: 9, padding: '4px 8px', fontFamily: 'monospace', boxSizing: 'border-box' }}
      />

      {portfolioSize > 0 && (
        <div style={{ fontSize: 7, color: '#475569', marginTop: 3 }}>
          {(portfolioSize / 1e6).toLocaleString('en-US')} million IDR
        </div>
      )}

      <div style={{ display: 'flex', gap: 3, marginTop: 5, flexWrap: 'wrap' }}>
        {presets.map(([valM, label]) => (
          <button key={label} onClick={() => onChange(valM * 1e6)}
            style={{ background: 'none', border: '1px solid #1E3A5F', borderRadius: 3, color: '#475569', fontSize: 7, fontWeight: 700, padding: '2px 5px', cursor: 'pointer', fontFamily: 'monospace' }}
          >{label}</button>
        ))}
      </div>

      <div style={{ fontSize: 7, color: '#334155', marginTop: 5, lineHeight: 1.4 }}>
        Drives IDR amounts in Analytics and ADT-based position caps when factor model is on. Re-REGENERATE after changing AUM to refresh caps in simulation.
      </div>
    </div>
  );
}

function FactorToggle({ label, checked, onChange, desc, scaleNote }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 4 }}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        <span style={{ fontSize: 9, color: '#E2E8F0', fontWeight: 700 }}>{label}</span>
      </label>
      <div style={{ fontSize: 8, color: '#64748B', marginBottom: 2, lineHeight: 1.4, paddingLeft: 22 }}>{desc}</div>
      <div style={{ fontSize: 7, color: '#475569', lineHeight: 1.4, paddingLeft: 22 }}>Scales as: {scaleNote}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Small reusable sub-components
// ─────────────────────────────────────────────────────────────────────────────

function UpsideValue({ value, emphasized = false }) {
  const label = fmtUpsidePct(value);
  const positive = value != null && value >= 0;
  return (
    <div style={{
      fontSize: emphasized ? 11 : 10,
      fontWeight: emphasized ? 700 : 600,
      color: value == null ? '#334155' : positive ? '#00FF88' : '#EF4444',
    }}>
      {label}
    </div>
  );
}

function SectionHeader({ children }) {
  return (
    <div style={{ fontSize: 9, color: '#334155', letterSpacing: 1.5, fontWeight: 700, textTransform: 'uppercase', marginBottom: 10 }}>
      {children}
    </div>
  );
}

function PortfolioSummaryCard({ title, icon, color, portfolio, riskFreeRate, scenarioStats, sharpeLabel = 'Sharpe', subtitle, benchmarkMetrics, portfolioSize = 0 }) {
  if (!portfolio) return null;
  const retVal  = portfolio.portfolioReturn ?? 0;
  const riskVal = portfolio.portfolioRisk ?? 0;
  const ret    = (retVal * 100).toFixed(2);
  const risk   = (riskVal * 100).toFixed(2);
  const excess = ((retVal - riskFreeRate) * 100).toFixed(2);
  const sharpe = reconcilePortfolioSharpe(portfolio, riskFreeRate).toFixed(3);
  const rows = [
    ['Return μ (ann.)',  `${parseFloat(ret) >= 0 ? '+' : ''}${ret}%`,  parseFloat(ret) >= 0 ? '#00FF88' : '#EF4444'],
    ['Risk σ (ann.)',    `${risk}%`,                                     '#00CFFD'],
    ['Excess Return',    `${parseFloat(excess) >= 0 ? '+' : ''}${excess}%`, '#94A3B8'],
    [sharpeLabel,        sharpe,                                          parseFloat(sharpe) > 1 ? '#FFD700' : parseFloat(sharpe) > 0.5 ? '#F59E0B' : '#EF4444'],
  ];
  if (scenarioStats) {
    rows.push(
      ['Return P10–P90', `${(scenarioStats.returnP10 * 100).toFixed(1)}% – ${(scenarioStats.returnP90 * 100).toFixed(1)}%`, '#94A3B8'],
    );
    if (scenarioStats.cvar5 != null) {
      rows.push(['CVaR 5%', `${(scenarioStats.cvar5 * 100).toFixed(1)}%`, '#EF4444']);
    }
    if (scenarioStats.tailGap != null) {
      const tg = scenarioStats.tailGap;
      rows.push(['Tail gap (μ−CVaR)', `${(tg * 100).toFixed(1)}pp`, tg > 0.15 ? '#EF4444' : tg > 0.08 ? '#F59E0B' : '#10B981']);
    }
    if (scenarioStats.probBelowRf != null) {
      const p = scenarioStats.probBelowRf * 100;
      rows.push(['P(r < rf)', `${p.toFixed(1)}%`, p > 40 ? '#EF4444' : p > 20 ? '#F59E0B' : '#10B981']);
    }
  }
  if (benchmarkMetrics) {
    rows.push(['Beta vs IHSG', benchmarkMetrics.beta.toFixed(3), '#64748B']);
    rows.push(['Corr vs IHSG', benchmarkMetrics.correlation.toFixed(3), '#64748B']);
    if (benchmarkMetrics.activeRisk != null) {
      rows.push(['Active risk σ', `${(benchmarkMetrics.activeRisk * 100).toFixed(1)}%`, '#64748B']);
    }
  }
  return (
    <div style={{ background: '#07111E', border: `1px solid ${color}33`, borderRadius: 8, padding: '14px 16px', flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: subtitle ? 4 : 12 }}>
        <span style={{ color, fontSize: 16 }}>{icon}</span>
        <span style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: 1 }}>{title}</span>
      </div>
      {subtitle && (
        <div style={{ fontSize: 7, color: '#475569', marginBottom: 10, letterSpacing: 0.5 }}>{subtitle}</div>
      )}
      {rows.map(([k, v, c]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
          <span style={{ fontSize: 9, color: '#475569' }}>{k}</span>
          <span style={{ fontSize: 12, color: c, fontWeight: 800, textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function WeightBar({ ticker, sector, weight, rcFrac, sectorColors, portfolioSize = 0 }) {
  const col = getSectorColor(sector, sectorColors);
  const rcPct = formatRiskContributionPct(rcFrac);
  const rcBarW = riskContributionBarWidth(rcFrac);
  const rcLabelColor = (rcFrac ?? 0) < -0.0005 ? '#10B981' : '#334155';
  const rcBarColor = (rcFrac ?? 0) < -0.0005 ? '#10B981' : '#F59E0B';
  const idr = portfolioSize > 0 ? weight * portfolioSize : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
      <span style={{ width: 40, fontSize: 10, color: col, fontWeight: 700 }}>{ticker}</span>
      <div style={{ flex: 1, position: 'relative' }}>
        {/* Weight bar */}
        <div style={{ height: 8, background: '#0A1628', borderRadius: 2, overflow: 'hidden', marginBottom: 2 }}>
          <div style={{ height: '100%', width: `${Math.min(weight * 100, 100)}%`, background: col, opacity: 0.8, borderRadius: 2, transition: 'width 0.2s' }} />
        </div>
        {/* RC bar — width clamped ≥0 so negative RC does not break layout */}
        <div style={{ height: 4, background: '#0A1628', borderRadius: 1, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${rcBarW}%`, background: rcBarColor, opacity: 0.6, borderRadius: 1 }} />
        </div>
      </div>
      <div style={{ width: portfolioSize > 0 ? 100 : 88, textAlign: 'right' }}>
        <span style={{ fontSize: 10, color: col, fontVariantNumeric: 'tabular-nums' }}>{(weight * 100).toFixed(1)}%</span>
        {idr != null && (
          <div style={{ fontSize: 7, color: '#64748B', fontVariantNumeric: 'tabular-nums' }}>{fmtIDR(idr)} IDR</div>
        )}
        <span style={{ fontSize: 8, color: rcLabelColor, marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>
          RC:{rcPct}
        </span>
      </div>
    </div>
  );
}
