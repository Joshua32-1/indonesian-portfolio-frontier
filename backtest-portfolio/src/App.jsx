import { useEffect, useMemo, useState } from 'react';
import { runBacktest } from './backtestEngine.js';
import UniverseToggle from './components/UniverseToggle.jsx';
import EquityCurveChart from './components/EquityCurveChart.jsx';
import MetricsTable from './components/MetricsTable.jsx';
import WeightsHistoryChart from './components/WeightsHistoryChart.jsx';
import AttributionTable from './components/AttributionTable.jsx';

export default function App() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [included, setIncluded] = useState(() => new Set());
  const [result, setResult] = useState(null);
  const [computing, setComputing] = useState(false);
  const [attrPortfolio, setAttrPortfolio] = useState('MinVar'); // attribution view selector

  // Load the pre-fetched history once.
  useEffect(() => {
    fetch('/backtest-history.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} — run \`npm run fetch\` first`); return r.json(); })
      .then(d => {
        setData(d);
        setIncluded(new Set(d.tickers.map(t => t.ticker))); // default = all 25
      })
      .catch(e => setLoadError(e.message));
  }, []);

  // Newest *included* listing — the name that binds the window.
  const newestIncluded = useMemo(() => {
    if (!data) return null;
    let best = null, bestDate = '0000-00-00';
    for (const t of data.tickers) {
      if (included.has(t.ticker) && t.listing > bestDate) { bestDate = t.listing; best = t.ticker; }
    }
    return best;
  }, [data, included]);

  // Re-run the backtest whenever the universe changes (deferred so the UI can paint).
  useEffect(() => {
    if (!data) return;
    setComputing(true);
    const id = setTimeout(() => {
      const res = runBacktest(data, [...included]);
      setResult(res);
      setComputing(false);
    }, 30);
    return () => clearTimeout(id);
  }, [data, included]);

  const toggle = t => setIncluded(prev => {
    const next = new Set(prev);
    next.has(t) ? next.delete(t) : next.add(t);
    return next;
  });
  const all = () => setIncluded(new Set(data.tickers.map(t => t.ticker)));
  const none = () => setIncluded(new Set());

  if (loadError) return <Shell><div style={{ color: '#F87171', padding: 24 }}>⚠️ {loadError}</div></Shell>;
  if (!data) return <Shell><div style={{ color: '#5B7A95', padding: 24 }}>Loading market history…</div></Shell>;

  const w = result?.window;
  const attr = result?.attribution?.[attrPortfolio];
  const order = attr ? [...attr.rows].sort((a, b) => b.avgWeight - a.avgWeight).map(r => r.ticker) : [];

  return (
    <Shell>
      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
        {/* Left: universe */}
        <div style={panel}>
          <UniverseToggle
            tickers={data.tickers}
            included={included}
            newestIncluded={newestIncluded}
            onToggle={toggle} onAll={all} onNone={none}
          />
        </div>

        {/* Right: window + chart + metrics */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={panel}>
            <WindowBar w={w} computing={computing} warnings={result?.warnings} />
          </div>
          <div style={panel}>
            <SectionTitle>EQUITY CURVES — gross, indexed to 100 at window start</SectionTitle>
            <EquityCurveChart chart={result?.chart} />
          </div>
          <div style={panel}>
            <SectionTitle>PERFORMANCE & RISK</SectionTitle>
            <MetricsTable metrics={result?.metrics} />
          </div>

          {attr && (
            <div style={panel}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <SectionTitle>REBALANCE HISTORY & ATTRIBUTION</SectionTitle>
                <span>
                  {['MinVar', 'EqualWeight'].map(p => (
                    <button key={p} onClick={() => setAttrPortfolio(p)} style={{
                      ...selBtn,
                      background: attrPortfolio === p ? '#10B981' : 'transparent',
                      color: attrPortfolio === p ? '#06231A' : '#7DA8C7',
                    }}>{p === 'MinVar' ? 'Min-Var' : 'Equal-Wt'}</button>
                  ))}
                </span>
              </div>
              <div style={{ fontSize: 10, color: '#5B7A95', marginBottom: 6 }}>
                Weight path across {attr.weightRows.length} weekly rebalances (top 12 names; rest = "Other").
              </div>
              <WeightsHistoryChart weightRows={attr.weightRows} order={order} />
              <div style={{ fontSize: 10, color: '#5B7A95', margin: '14px 0 4px' }}>
                Return contribution is Carino-linked (sums to the {(attr.totalReturn * 100).toFixed(1)}% total return);
                risk contribution = Cov(wᵢrᵢ, r_p)/Var(r_p), realized (sums to 100%).
              </div>
              <AttributionTable rows={attr.rows} />
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function WindowBar({ w, computing, warnings }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <Stat label="WINDOW" value={w ? `${w.start} → ${w.end}` : '—'} />
        <Stat label="REBALANCES" value={w ? `${w.nRebalances} weeks` : '—'} />
        <Stat label="NAMES" value={w ? `${w.nTickers}` : '—'} />
        <Stat label="WINDOW BOUND BY" value={w ? w.newestListing : '—'} sub="newest listing + 1yr" />
        <Stat label="r_f" value={w ? `${(w.riskFreeRate * 100).toFixed(2)}%` : '—'} sub="BI-Rate" />
        {computing && <span style={{ color: '#F59E0B', fontSize: 11 }}>computing…</span>}
      </div>
      {warnings?.length > 0 && (
        <div style={{ marginTop: 8, color: '#F59E0B', fontSize: 11 }}>
          {warnings.map((m, i) => <div key={i}>⚠️ {m}</div>)}
        </div>
      )}
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

const panel = {
  background: '#0E1F35', border: '1px solid #16304D', borderRadius: 10, padding: 14,
};

const selBtn = {
  border: '1px solid #1E3A5F', borderRadius: 5, fontSize: 11, fontWeight: 700,
  cursor: 'pointer', padding: '3px 12px', marginLeft: 4,
};

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#0A1628', color: '#E2E8F0', fontFamily: 'system-ui, sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 4px' }}>
          IDX Covariance-Only Backtest
        </h1>
        <p style={{ fontSize: 12, color: '#5B7A95', margin: '0 0 18px' }}>
          Weekly-rebalanced minimum-variance vs equal-weight vs IHSG. Σ = weekly ρ × theta-decay daily σ
          (half-life 63, 252-day), Ledoit-Wolf shrinkage. Long-only, no caps. Gross of costs.
        </p>
        {children}
      </div>
    </div>
  );
}
