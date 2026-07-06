/**
 * App.jsx — IDX Portfolio Tracker
 * Read-only forward tracker: indexed performance + metrics across the full
 * comparison matrix — 6 strategy variants × 3 Black-Litterman priors × 3
 * rebalance frequencies × gross/net of IDX costs. Prior/frequency/cost are
 * selectors; the chart+table show the selected slice (6 variants + IHSG), so
 * every combination is explorable and directly comparable to the backtest.
 * Data sources: /live-market-snapshot.json + /portfolios.json (both static).
 */

import { useState, useEffect, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import {
  buildTrackerSeries,
  buildIHSGSeries,
  mergeChartRows,
  sinceInceptionReturn,
  weightsAtDate,
  latestRebalanceDate,
  extractDailyReturns,
  calcAnnualizedReturn,
  calcAnnualizedVol,
  calcMaxDrawdown,
  calcSharpe,
  calcTrackingError,
  calcInfoRatio,
} from './math/portfolioIndex.js';
import { buildLiveAttribution } from './math/attribution.js';
import WeightsHistoryChart from './components/WeightsHistoryChart.jsx';
import AttributionTable    from './components/AttributionTable.jsx';

// ── Palette (keyed by strategy BASE id; priors share a base colour) ─────────────

const COLORS = {
  IHSG:       '#94A3B8',
  'max-sharpe': '#FFD700',
  'min-var':    '#00CFFD',
  'tail-10':    '#FF6B6B',
  'tail-20':    '#FF8E53',
  'tail-35':    '#A78BFA',
  'tail-50':    '#34D399',
};

// Matrix axes
const PRIORS = [
  { id: 'cap',    label: 'Market-cap' },
  { id: 'shrunk', label: 'Shrunk' },
  { id: 'equal',  label: 'Equal-weight' },
];
const FREQS = [
  { id: 'weekly',    label: 'Weekly' },
  { id: 'monthly',   label: 'Monthly' },
  { id: 'quarterly', label: 'Quarterly' },
];
const METHODS = [
  { id: 'bl',   label: 'Black-Litterman' },
  { id: 'pert', label: 'Legacy PERT' },
];
const TAUS = [
  { id: 0.01, label: 'τ=0.01' },
  { id: 0.03, label: 'τ=0.03' },
  { id: 0.1,  label: 'τ=0.10' },
];
const KAPPAS = [
  { id: 0,    label: 'κ=0 (full)' },
  { id: 0.1,  label: 'κ=0.10' },
  { id: 0.25, label: 'κ=0.25' },
  { id: 0.5,  label: 'κ=0.50' },
  { id: 0.75, label: 'κ=0.75' },
];

/** Strategy base id from a portfolio entry (explicit `base`, else strip `@prior`). */
const baseOf = (p) => p.base ?? String(p.id).split('@')[0];

const BG       = '#05080F';
const PANEL    = '#07111E';
const BORDER   = '#1E3A5F';
const TEXT_DIM = '#475569';
const TEXT_MED = '#94A3B8';
const TEXT_HI  = '#E2E8F0';

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  root: {
    minHeight: '100vh',
    background: BG,
    color: TEXT_HI,
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
    padding: '20px 24px 48px',
    maxWidth: 1100,
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
    borderBottom: `1px solid ${BORDER}`,
    paddingBottom: 16,
    flexWrap: 'wrap',
    gap: 8,
  },
  title: { fontSize: 18, fontWeight: 700, letterSpacing: 1, color: TEXT_HI },
  subtitle: { fontSize: 10, color: TEXT_DIM, marginTop: 4, lineHeight: 1.6 },
  metaRight: { textAlign: 'right', fontSize: 9, color: TEXT_DIM, lineHeight: 1.8 },
  panel: {
    background: PANEL,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '16px 18px',
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 2,
    color: TEXT_DIM,
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  controlsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
    alignItems: 'center',
  },
  selectLabel: {
    fontSize: 9, color: TEXT_DIM, letterSpacing: 1,
    display: 'flex', alignItems: 'center', gap: 6, textTransform: 'uppercase',
  },
  select: {
    background: '#0A1628', color: TEXT_MED, border: `1px solid ${BORDER}`,
    borderRadius: 4, padding: '3px 8px', fontSize: 10, fontFamily: 'monospace', cursor: 'pointer',
  },
  segBtn: (on) => ({
    background: on ? '#0EA5E912' : '#040A13',
    color: on ? '#38BDF8' : TEXT_DIM,
    border: `1px solid ${on ? '#0EA5E988' : BORDER}`,
    borderRadius: 4, padding: '3px 12px', fontSize: 10, fontWeight: on ? 700 : 400,
    cursor: 'pointer', letterSpacing: 0.5,
  }),
  legendRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  chip: (color, on) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '4px 10px',
    borderRadius: 4,
    border: `1px solid ${on ? color + '88' : BORDER}`,
    background: on ? color + '12' : '#040A13',
    color: on ? color : TEXT_DIM,
    fontSize: 9,
    fontWeight: on ? 700 : 400,
    cursor: 'pointer',
    userSelect: 'none',
    letterSpacing: 0.5,
  }),
  dot: (color) => ({
    width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0,
  }),
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 10,
  },
  th: {
    textAlign: 'right',
    color: TEXT_DIM,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    padding: '6px 10px',
    borderBottom: `1px solid ${BORDER}`,
  },
  thLeft: {
    textAlign: 'left',
    color: TEXT_DIM,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    padding: '6px 10px',
    borderBottom: `1px solid ${BORDER}`,
  },
  td: (highlight) => ({
    textAlign: 'right',
    padding: '5px 10px',
    color: highlight ? TEXT_HI : TEXT_MED,
    fontWeight: highlight ? 700 : 400,
    borderBottom: `1px solid #0A1628`,
  }),
  tdLeft: {
    textAlign: 'left',
    padding: '5px 10px',
    color: TEXT_HI,
    fontWeight: 700,
    borderBottom: `1px solid #0A1628`,
  },
  empty: {
    textAlign: 'center',
    padding: '48px 0',
    color: TEXT_DIM,
    fontSize: 12,
    lineHeight: 2,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPct(decimal, sign = true) {
  if (decimal == null || !isFinite(decimal)) return '—';
  const pct = decimal * 100;
  return `${sign && pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function fmtTs(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtRatio(val) {
  if (val == null || !isFinite(val)) return '—';
  return val.toFixed(2);
}

// ── Chart tooltip ─────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: '#07111E', border: `1px solid ${BORDER}`,
      borderRadius: 6, padding: '8px 12px', fontSize: 10,
    }}>
      <div style={{ color: TEXT_DIM, marginBottom: 6, letterSpacing: 1 }}>{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.stroke, marginBottom: 3 }}>
          <span style={{ marginRight: 8 }}>{p.name}</span>
          <b>{p.value != null ? p.value.toFixed(1) : '—'}</b>
          {p.value != null && (
            <span style={{ color: TEXT_DIM, marginLeft: 6 }}>
              ({fmtPct(p.value / 100 - 1)})
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [snapshot, setSnapshot]     = useState(null);
  const [portfoliosData, setPortfoliosData] = useState(null);
  const [error, setError]           = useState(null);
  const [visible, setVisible]       = useState(null); // set after data loads (toggled-off lines)
  const [weightDate, setWeightDate] = useState(null); // null → resolves to latest rebalance date
  const [attrPortfolio, setAttrPortfolio] = useState(null); // null → first strategy in slice

  // Matrix selectors
  const [methodology, setMethodology] = useState('bl'); // 'bl' | 'pert'
  const [prior, setPrior]         = useState('cap');
  const [tau, setTau]             = useState(0.03);
  const [kappa, setKappa]         = useState(0);
  const [frequency, setFrequency] = useState('weekly');
  const [costBasis, setCostBasis] = useState('gross'); // 'gross' | 'net'
  const net = costBasis === 'net';

  // Load both JSON files
  useEffect(() => {
    Promise.all([
      fetch('/live-market-snapshot.json').then(r => {
        if (!r.ok) throw new Error(`Snapshot fetch failed: ${r.status}`);
        return r.json();
      }),
      fetch('/portfolios.json').then(r => {
        if (!r.ok) throw new Error(`Portfolios fetch failed: ${r.status}`);
        return r.json();
      }),
    ])
      .then(([snap, ports]) => {
        setSnapshot(snap);
        setPortfoliosData(ports);
        // Default: all lines visible (IHSG + every composite id)
        setVisible(new Set(['IHSG', ...ports.portfolios.map(p => p.id)]));
      })
      .catch(err => setError(err.message));
  }, []);

  // Build chart data + metrics for the SELECTED SLICE (prior) at the selected frequency / cost basis
  const { chartRows, metrics, portfolios, allTickers, rebalanceDates } = useMemo(() => {
    if (!snapshot || !portfoliosData) return {};

    const assets       = snapshot.assets ?? [];
    const benchmark    = snapshot.benchmark?.priceHistory ?? null;
    const inception    = portfoliosData.inception;
    const all          = portfoliosData.portfolios ?? [];
    const riskFreeRate = portfoliosData.riskFreeRate ?? 0.0575;

    // Slice = the 6 variants for the selected methodology config at the selected κ.
    // PERT ignores prior/τ; BL slices by (prior, τ); both slice by κ (missing κ ⇒ 0).
    // Falls back to "all" for a flat legacy schema (no methodology field).
    const hasMatrix = all.some(p => p.methodology != null);
    const kEq = p => (p.kappa ?? 0) === kappa;
    const portfolios = !hasMatrix ? all
      : methodology === 'pert'
        ? all.filter(p => p.methodology === 'pert' && kEq(p))
        : all.filter(p => p.methodology === 'bl' && p.prior === prior && p.tau === tau && kEq(p));

    const opts = { frequency, net };

    // IHSG series (cost/frequency agnostic)
    const ihsgSeries = buildIHSGSeries(benchmark, inception);

    // Portfolio series for the slice
    const portSeriesMap = {};
    for (const port of portfolios) {
      portSeriesMap[port.id] = buildTrackerSeries(port, assets, benchmark, inception, opts);
    }

    const allSeries = [
      { id: 'IHSG', series: ihsgSeries },
      ...portfolios.map(p => ({ id: p.id, series: portSeriesMap[p.id] ?? [] })),
    ];
    const chartRows = mergeChartRows(allSeries);

    const ihsgRetByDate = new Map();
    for (const row of ihsgSeries) {
      if (row.rp !== undefined) ihsgRetByDate.set(row.date, row.rp);
    }
    function alignedPortBench(portSeries) {
      const portRets = [], benchRets = [];
      for (const row of portSeries.slice(1)) {
        const br = ihsgRetByDate.get(row.date);
        if (br !== undefined) { portRets.push(row.rp); benchRets.push(br); }
      }
      return { portRets, benchRets };
    }

    const ihsgDailyRets = extractDailyReturns(ihsgSeries);
    const ihsgAnnRet    = calcAnnualizedReturn(ihsgSeries);
    const ihsgAnnVol    = calcAnnualizedVol(ihsgDailyRets);

    const metrics = {
      IHSG: {
        totalReturn:   sinceInceptionReturn(ihsgSeries),
        annReturn:     ihsgAnnRet,
        annVol:        ihsgAnnVol,
        maxDrawdown:   calcMaxDrawdown(ihsgSeries),
        sharpe:        null,
        trackingError: null,
        infoRatio:     null,
      },
    };

    for (const port of portfolios) {
      const series    = portSeriesMap[port.id] ?? [];
      const dailyRets = extractDailyReturns(series);
      const annRet    = calcAnnualizedReturn(series);
      const annVol    = calcAnnualizedVol(dailyRets);
      const { portRets, benchRets } = alignedPortBench(series);
      const te        = calcTrackingError(portRets, benchRets);
      const excess    = annRet != null && ihsgAnnRet != null ? annRet - ihsgAnnRet : null;
      metrics[port.id] = {
        totalReturn:   sinceInceptionReturn(series),
        annReturn:     annRet,
        annVol,
        maxDrawdown:   calcMaxDrawdown(series),
        sharpe:        calcSharpe(annRet, annVol, riskFreeRate),
        trackingError: te,
        infoRatio:     calcInfoRatio(excess, te),
      };
    }

    const allTickers = [...new Set(
      portfolios.flatMap(p => (p.rebalances ?? []).flatMap(r => Object.keys(r.weights ?? {})))
    )].sort();

    const rebalanceDates = [...new Set(
      portfolios.flatMap(p => (p.rebalances ?? []).map(r => r.effective))
    )].sort((a, b) => (a < b ? 1 : -1));

    return { chartRows, metrics, portfolios, allTickers, rebalanceDates };
  }, [snapshot, portfoliosData, methodology, prior, tau, kappa, frequency, net]);

  // Date-aware weight rows: weights active on the selected rebalance date (default latest)
  const activeWeightDate = weightDate ?? rebalanceDates?.[0] ?? null;
  const weightRows = useMemo(() => {
    if (!portfolios?.length || !activeWeightDate) return [];
    return allTickers.map(ticker => {
      const row = { ticker };
      for (const p of portfolios) {
        const w = weightsAtDate(p.rebalances, activeWeightDate);
        row[p.id] = (w[ticker] ?? 0) * 100;
      }
      return row;
    });
  }, [portfolios, allTickers, activeWeightDate]);

  // Attribution: per-asset contribution for the selected strategy (within the slice)
  const activeAttrId = (attrPortfolio && portfolios?.some(p => p.id === attrPortfolio))
    ? attrPortfolio
    : portfolios?.[0]?.id ?? null;
  const attribution = useMemo(() => {
    if (!portfolios?.length || !snapshot?.assets || !activeAttrId || !portfoliosData?.inception) return null;
    const p = portfolios.find(p => p.id === activeAttrId) ?? portfolios[0];
    return buildLiveAttribution(p, snapshot.assets, portfoliosData.inception);
  }, [portfolios, snapshot, portfoliosData?.inception, activeAttrId]);

  function toggleLine(id) {
    setVisible(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div style={{ ...s.root }}>
        <div style={s.empty}>
          <div style={{ fontSize: 16, color: '#EF4444', marginBottom: 8 }}>Failed to load data</div>
          <div style={{ color: TEXT_DIM, fontSize: 11 }}>{error}</div>
          <div style={{ color: TEXT_DIM, fontSize: 10, marginTop: 12 }}>
            Ensure <code style={{ color: '#F59E0B' }}>live-market-snapshot.json</code> and{' '}
            <code style={{ color: '#F59E0B' }}>portfolios.json</code> exist in{' '}
            <code style={{ color: '#F59E0B' }}>data/</code>.
          </div>
        </div>
      </div>
    );
  }

  if (!snapshot || !portfoliosData || !visible) {
    return (
      <div style={{ ...s.root }}>
        <div style={s.empty}>
          <div style={{ color: TEXT_DIM }}>Loading…</div>
        </div>
      </div>
    );
  }

  const inception = portfoliosData.inception;
  const snapshotEnd = snapshot.historyRange?.end ?? '—';
  const latestRebalance = portfolios?.length
    ? portfolios.map(p => latestRebalanceDate(p.rebalances) ?? '').sort().at(-1) || '—'
    : '—';
  const priorLabel = PRIORS.find(x => x.id === prior)?.label ?? prior;
  const freqLabel  = FREQS.find(x => x.id === frequency)?.label ?? frequency;
  const configLabel = (methodology === 'pert' ? 'Legacy PERT' : `BL · ${priorLabel} · τ=${tau.toFixed(2)}`)
    + ` · κ=${kappa.toFixed(2)}`;

  return (
    <div style={s.root}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={s.header}>
        <div>
          <div style={s.title}>IDX PORTFOLIO TRACKER</div>
          <div style={s.subtitle}>
            Indexed to 100 at inception · daily adjusted close · Jakarta Composite (IHSG) benchmark ·
            comparison matrix: 6 variants × prior × frequency × gross/net
          </div>
        </div>
        <div style={s.metaRight}>
          <div>Inception: <span style={{ color: TEXT_MED }}>{inception}</span></div>
          <div>Data through: <span style={{ color: TEXT_MED }}>{snapshotEnd}</span></div>
          <div>Weights as of: <span style={{ color: TEXT_MED }}>{latestRebalance}</span></div>
          <div>Snapshot: <span style={{ color: TEXT_DIM }}>{fmtTs(snapshot.generated)}</span></div>
        </div>
      </div>

      {/* ── Matrix controls ─────────────────────────────────────────────── */}
      <div style={{ ...s.panel, marginBottom: 16 }}>
        <div style={s.controlsRow}>
          <label style={s.selectLabel}>
            Methodology
            <select style={s.select} value={methodology} onChange={e => setMethodology(e.target.value)}>
              {METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          {methodology === 'bl' && (
            <label style={s.selectLabel}>
              Prior
              <select style={s.select} value={prior} onChange={e => setPrior(e.target.value)}>
                {PRIORS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
          )}
          {methodology === 'bl' && (
            <label style={s.selectLabel}>
              Tau
              <select style={s.select} value={tau} onChange={e => setTau(Number(e.target.value))}>
                {TAUS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
          )}
          <label style={s.selectLabel}>
            Turnover κ
            <select style={s.select} value={kappa} onChange={e => setKappa(Number(e.target.value))}>
              {KAPPAS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </label>
          <label style={s.selectLabel}>
            Frequency
            <select style={s.select} value={frequency} onChange={e => setFrequency(e.target.value)}>
              {FREQS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <span style={s.selectLabel}>
            Cost
            <span style={{ display: 'inline-flex', gap: 4 }}>
              <button style={s.segBtn(!net)} onClick={() => setCostBasis('gross')}>Gross</button>
              <button style={s.segBtn(net)}  onClick={() => setCostBasis('net')}>Net</button>
            </span>
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 9, color: TEXT_DIM, maxWidth: 360, lineHeight: 1.5 }}>
            Forward evidence accrues slowly — early weeks are dominated by noise; read the 15-year
            backtest tearsheet for discrimination, this for out-of-sample confirmation.
          </span>
        </div>
      </div>

      {/* ── Performance metrics table ────────────────────────────────── */}
      <div style={s.panel}>
        <div style={s.sectionLabel}>
          Performance Metrics · Since Inception · {configLabel} · {freqLabel} · {net ? 'net of cost' : 'gross'}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.thLeft}>Strategy</th>
                <th style={s.th}>Total Return</th>
                <th style={s.th}>Ann. Return</th>
                <th style={s.th}>Ann. Vol</th>
                <th style={s.th}>Sharpe</th>
                <th style={s.th}>Max DD</th>
                <th style={s.th}>Tracking Error</th>
                <th style={s.th}>Info Ratio</th>
              </tr>
            </thead>
            <tbody>
              {/* IHSG benchmark row */}
              {(() => {
                const m = metrics?.['IHSG'];
                return (
                  <tr>
                    <td style={s.tdLeft}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={s.dot(COLORS.IHSG)} />
                        IHSG
                        <span style={{ color: TEXT_DIM, fontWeight: 400, fontSize: 9 }}>Benchmark</span>
                      </span>
                    </td>
                    <td style={{ ...s.td(false), color: m?.totalReturn > 0 ? '#00FF88' : m?.totalReturn < 0 ? '#EF4444' : TEXT_MED }}>{fmtPct(m?.totalReturn)}</td>
                    <td style={{ ...s.td(false), color: m?.annReturn > 0 ? '#00FF88' : m?.annReturn < 0 ? '#EF4444' : TEXT_MED }}>{fmtPct(m?.annReturn)}</td>
                    <td style={s.td(false)}>{fmtPct(m?.annVol, false)}</td>
                    <td style={s.td(false)}>—</td>
                    <td style={{ ...s.td(false), color: m?.maxDrawdown < 0 ? '#EF4444' : TEXT_MED }}>{fmtPct(m?.maxDrawdown, false)}</td>
                    <td style={s.td(false)}>—</td>
                    <td style={s.td(false)}>—</td>
                  </tr>
                );
              })()}

              {/* Portfolio rows (selected slice) */}
              {(portfolios ?? []).map(p => {
                const m   = metrics?.[p.id];
                const col = COLORS[baseOf(p)] ?? '#64748B';
                return (
                  <tr key={p.id}>
                    <td style={s.tdLeft}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={s.dot(col)} />
                        {p.label}
                      </span>
                    </td>
                    <td style={{ ...s.td(false), color: m?.totalReturn > 0 ? '#00FF88' : m?.totalReturn < 0 ? '#EF4444' : TEXT_MED }}>{fmtPct(m?.totalReturn)}</td>
                    <td style={{ ...s.td(false), color: m?.annReturn > 0 ? '#00FF88' : m?.annReturn < 0 ? '#EF4444' : TEXT_MED }}>{fmtPct(m?.annReturn)}</td>
                    <td style={s.td(false)}>{fmtPct(m?.annVol, false)}</td>
                    <td style={{ ...s.td(false), color: m?.sharpe > 0 ? '#00FF88' : m?.sharpe < 0 ? '#EF4444' : TEXT_MED, fontWeight: m?.sharpe > 1 ? 700 : 400 }}>{fmtRatio(m?.sharpe)}</td>
                    <td style={{ ...s.td(false), color: m?.maxDrawdown < 0 ? '#EF4444' : TEXT_MED }}>{fmtPct(m?.maxDrawdown, false)}</td>
                    <td style={s.td(false)}>{fmtPct(m?.trackingError, false)}</td>
                    <td style={{ ...s.td(false), color: m?.infoRatio > 0 ? '#00FF88' : m?.infoRatio < 0 ? '#EF4444' : TEXT_MED, fontWeight: m?.infoRatio > 0.5 ? 700 : 400 }}>{fmtRatio(m?.infoRatio)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8, fontSize: 9, color: TEXT_DIM }}>
          Sharpe = (ann. return − {((portfoliosData?.riskFreeRate ?? 0.0575) * 100).toFixed(2)}% BI-Rate) / ann. vol ·
          {net ? ' net = gross − IDX turnover cost (liquidity-aware half-spread + fees) at each rebalance · ' : ' '}
          Annualized metrics are volatile at short horizons; stabilize ~63 trading days from inception.
        </div>
      </div>

      {/* ── Performance chart ───────────────────────────────────────────── */}
      <div style={s.panel}>
        <div style={s.sectionLabel}>
          Indexed Performance · rebased to 100 at {inception} · {configLabel} · {freqLabel} · {net ? 'net' : 'gross'}
        </div>

        {!chartRows?.length ? (
          <div style={s.empty}>
            <div style={{ fontSize: 12, color: TEXT_DIM }}>
              No chart data. Daily adj close data may still be settling for recent sessions
              (Yahoo typically lags 1–2 trading days). Check that inception ({inception}) is within
              the snapshot price history and that portfolios.json weights sum to ~1.
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={380}>
            <LineChart data={chartRows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="#0A1628" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fill: TEXT_DIM, fontSize: 8 }}
                tickFormatter={d => d?.slice(5)}
                minTickGap={30}
              />
              <YAxis
                tick={{ fill: TEXT_DIM, fontSize: 8 }}
                domain={['auto', 'auto']}
                width={46}
                tickFormatter={v => v?.toFixed(0)}
              />
              <ReferenceLine y={100} stroke={BORDER} strokeDasharray="4 4" />
              <Tooltip content={<ChartTooltip />} />

              {/* IHSG — always shown if visible */}
              {visible.has('IHSG') && (
                <Line
                  type="monotone"
                  dataKey="IHSG"
                  name="IHSG"
                  stroke={COLORS.IHSG}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              )}

              {(portfolios ?? []).map(p => visible.has(p.id) && (
                <Line
                  key={p.id}
                  type="monotone"
                  dataKey={p.id}
                  name={p.label}
                  stroke={COLORS[baseOf(p)] ?? '#64748B'}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}

        {/* Toggle chips */}
        <div style={s.legendRow}>
          <button onClick={() => toggleLine('IHSG')} style={s.chip(COLORS.IHSG, visible.has('IHSG'))}>
            <span style={s.dot(visible.has('IHSG') ? COLORS.IHSG : BORDER)} />
            IHSG
          </button>
          {(portfolios ?? []).map(p => {
            const col = COLORS[baseOf(p)] ?? '#64748B';
            const on  = visible.has(p.id);
            return (
              <button key={p.id} onClick={() => toggleLine(p.id)} style={s.chip(col, on)}>
                <span style={s.dot(on ? col : BORDER)} />
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Weight matrix ───────────────────────────────────────────────── */}
      <div style={s.panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={s.sectionLabel}>Portfolio Weights · {configLabel}</div>
          {(rebalanceDates?.length ?? 0) > 1 && (
            <label style={{ fontSize: 9, color: TEXT_DIM, letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              REBALANCE
              <select
                value={activeWeightDate ?? ''}
                onChange={e => setWeightDate(e.target.value)}
                style={s.select}
              >
                {rebalanceDates.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
        </div>

        {!weightRows?.length ? (
          <div style={{ color: TEXT_DIM, fontSize: 11 }}>
            No weight data. Update portfolios.json after your first REGENERATE run.
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.thLeft}>Ticker</th>
                    {(portfolios ?? []).map(p => (
                      <th key={p.id} style={{ ...s.th, color: COLORS[baseOf(p)] ?? TEXT_DIM }}>
                        {p.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {weightRows.map(row => {
                    const vals  = (portfolios ?? []).map(p => row[p.id] ?? 0);
                    const maxW  = Math.max(...vals);
                    return (
                      <tr key={row.ticker}>
                        <td style={s.tdLeft}>{row.ticker}</td>
                        {(portfolios ?? []).map(p => {
                          const w = row[p.id] ?? 0;
                          return (
                            <td key={p.id} style={s.td(w === maxW && w > 0)}>
                              {w > 0 ? `${w.toFixed(1)}%` : '—'}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {/* Sum row */}
                  <tr style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td style={{ ...s.tdLeft, color: TEXT_DIM }}>TOTAL</td>
                    {(portfolios ?? []).map(p => {
                      const total = weightRows.reduce((acc, r) => acc + (r[p.id] ?? 0), 0);
                      const ok = Math.abs(total - 100) < 1;
                      return (
                        <td key={p.id} style={{ ...s.td(false), color: ok ? '#00FF88' : '#EF4444', fontWeight: 700 }}>
                          {total.toFixed(1)}%
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10, fontSize: 9, color: TEXT_DIM }}>
              Showing weights active on <span style={{ color: TEXT_MED }}>{activeWeightDate ?? '—'}</span>.
              Each strategy reflects its most recent rebalance on or before this date.
            </div>
          </>
        )}
      </div>

      {/* ── Rebalance History & Attribution ─────────────────────────────── */}
      <div style={s.panel}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={s.sectionLabel}>REBALANCE HISTORY & ATTRIBUTION · {configLabel}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(portfolios ?? []).map(p => (
              <button
                key={p.id}
                onClick={() => setAttrPortfolio(p.id)}
                style={{
                  background:    activeAttrId === p.id ? (COLORS[baseOf(p)] ?? '#64748B') : 'transparent',
                  color:         activeAttrId === p.id ? '#05080F' : (COLORS[baseOf(p)] ?? TEXT_DIM),
                  border:        `1px solid ${COLORS[baseOf(p)] ?? BORDER}`,
                  borderRadius:  4,
                  padding:       '2px 8px',
                  fontSize:      9,
                  fontFamily:    'inherit',
                  cursor:        'pointer',
                  letterSpacing: 0.5,
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {(attribution?.weightRows?.length ?? 0) < 2 ? (
          <div style={{ color: TEXT_DIM, fontSize: 10, padding: '12px 0' }}>
            Attribution view requires 2 or more rebalance periods.
            Check back after the first weekly rebalance on {inception}.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 9, color: TEXT_DIM, marginBottom: 8 }}>
              Weight path across {attribution.weightRows.length} rebalances (top 12 names; rest = "Other").
            </div>
            <WeightsHistoryChart
              weightRows={attribution.weightRows}
              order={attribution.order}
            />
            <div style={{ fontSize: 9, color: TEXT_DIM, margin: '10px 0 6px' }}>
              Return contribution is Carino-linked (sums to{' '}
              <span style={{ color: TEXT_MED }}>{attribution.totalReturn != null ? `${(attribution.totalReturn * 100).toFixed(1)}%` : '—'}</span>
              {' '}total return); risk contribution = Cov(w_f, r_p)/Var(r_p), realized (sums to 100%).
            </div>
            <AttributionTable rows={attribution.rows} />
          </>
        )}
      </div>

    </div>
  );
}
