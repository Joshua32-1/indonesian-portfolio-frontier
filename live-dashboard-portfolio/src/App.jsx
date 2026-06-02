/**
 * App.jsx — IDX Portfolio Tracker
 * Minimal read-only dashboard: indexed performance chart + weight matrix.
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
  latestWeights,
  latestRebalanceDate,
} from './math/portfolioIndex.js';

// ── Palette ───────────────────────────────────────────────────────────────────

const COLORS = {
  IHSG:       '#94A3B8',
  'max-sharpe': '#FFD700',
  'min-var':    '#00CFFD',
  'tail-10':    '#FF6B6B',
  'tail-20':    '#FF8E53',
  'tail-35':    '#A78BFA',
  'tail-50':    '#34D399',
};

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
  kpiRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 0,
  },
  kpiCard: (color, active) => ({
    background: active ? `${color}10` : '#040A13',
    border: `1px solid ${active ? color + '55' : BORDER}`,
    borderRadius: 6,
    padding: '10px 14px',
    minWidth: 130,
    flex: '1 1 130px',
    cursor: 'default',
  }),
  kpiLabel: (color) => ({ fontSize: 9, color, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }),
  kpiValue: { fontSize: 18, fontWeight: 700, color: TEXT_HI, lineHeight: 1 },
  kpiSub: { fontSize: 9, color: TEXT_DIM, marginTop: 4 },
  legendRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
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

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 7); // YYYY-MM
}

function fmtTs(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
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
  const [visible, setVisible]       = useState(null); // set after data loads

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
        // Default: all visible
        const ids = new Set(['IHSG', ...ports.portfolios.map(p => p.id)]);
        setVisible(ids);
      })
      .catch(err => setError(err.message));
  }, []);

  // Build chart data
  const { chartRows, kpis, weightRows, portfolios, allTickers } = useMemo(() => {
    if (!snapshot || !portfoliosData) return {};

    const assets    = snapshot.assets ?? [];
    const benchmark = snapshot.benchmark?.priceHistory ?? null;
    const inception = portfoliosData.inception;
    const portfolios = portfoliosData.portfolios ?? [];

    // IHSG series
    const ihsgSeries = buildIHSGSeries(benchmark, inception);

    // Portfolio series
    const portSeriesMap = {};
    for (const port of portfolios) {
      portSeriesMap[port.id] = buildTrackerSeries(port, assets, benchmark, inception);
    }

    // Merge into Recharts rows
    const allSeries = [
      { id: 'IHSG', series: ihsgSeries },
      ...portfolios.map(p => ({ id: p.id, series: portSeriesMap[p.id] ?? [] })),
    ];
    const chartRows = mergeChartRows(allSeries);

    // KPIs
    const kpis = {
      IHSG: sinceInceptionReturn(ihsgSeries),
      ...Object.fromEntries(portfolios.map(p => [p.id, sinceInceptionReturn(portSeriesMap[p.id] ?? [])])),
    };

    // Weight table: all tickers across all latest weight sets
    const allTickers = [...new Set(
      portfolios.flatMap(p => Object.keys(latestWeights(p)))
    )].sort();

    const weightRows = allTickers.map(ticker => {
      const row = { ticker };
      for (const p of portfolios) row[p.id] = (latestWeights(p)[ticker] ?? 0) * 100;
      return row;
    });

    return { chartRows, kpis, weightRows, portfolios, allTickers };
  }, [snapshot, portfoliosData]);

  function toggleLine(id) {
    setVisible(prev => {
      const next = new Set(prev);
      // Never allow removing IHSG as the only reference — but allow toggling
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
  const latestRebalance = portfolios
    ? Math.max(...portfolios.map(p => latestRebalanceDate(p.rebalances) ?? ''))
    : '—';

  return (
    <div style={s.root}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={s.header}>
        <div>
          <div style={s.title}>IDX PORTFOLIO TRACKER</div>
          <div style={s.subtitle}>
            Indexed to 100 at inception · daily adjusted close · Jakarta Composite (IHSG) benchmark
          </div>
        </div>
        <div style={s.metaRight}>
          <div>Inception: <span style={{ color: TEXT_MED }}>{inception}</span></div>
          <div>Data through: <span style={{ color: TEXT_MED }}>{snapshotEnd}</span></div>
          <div>Weights as of: <span style={{ color: TEXT_MED }}>{latestRebalance}</span></div>
          <div>Snapshot: <span style={{ color: TEXT_DIM }}>{fmtTs(snapshot.generated)}</span></div>
        </div>
      </div>

      {/* ── KPI strip ───────────────────────────────────────────────────── */}
      <div style={s.panel}>
        <div style={s.sectionLabel}>Since Inception · Total Return</div>
        <div style={s.kpiRow}>

          {/* IHSG */}
          {(() => {
            const ret = kpis?.['IHSG'];
            return (
              <div style={s.kpiCard(COLORS.IHSG, visible?.has('IHSG'))}>
                <div style={s.kpiLabel(COLORS.IHSG)}>IHSG</div>
                <div style={s.kpiValue}>{fmtPct(ret)}</div>
                <div style={s.kpiSub}>Benchmark</div>
              </div>
            );
          })()}

          {(portfolios ?? []).map(p => {
            const ret  = kpis?.[p.id];
            const ihsg = kpis?.['IHSG'];
            const active = ret != null && ihsg != null ? ret - ihsg : null;
            const col  = COLORS[p.id] ?? '#64748B';
            const isPos = active != null && active > 0;
            return (
              <div key={p.id} style={s.kpiCard(col, visible?.has(p.id))}>
                <div style={s.kpiLabel(col)}>{p.label}</div>
                <div style={s.kpiValue}>{fmtPct(ret)}</div>
                <div style={s.kpiSub}>
                  Active:{' '}
                  <span style={{ color: isPos ? '#00FF88' : active != null && active < 0 ? '#EF4444' : TEXT_DIM }}>
                    {fmtPct(active)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Performance chart ───────────────────────────────────────────── */}
      <div style={s.panel}>
        <div style={s.sectionLabel}>
          Indexed Performance · rebased to 100 at {inception}
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
                  stroke={COLORS[p.id] ?? '#64748B'}
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
          {['IHSG', ...(portfolios ?? []).map(p => p.id)].map(id => {
            const label = id === 'IHSG' ? 'IHSG' : portfolios?.find(p => p.id === id)?.label ?? id;
            const col   = COLORS[id] ?? '#64748B';
            const on    = visible.has(id);
            return (
              <button
                key={id}
                onClick={() => toggleLine(id)}
                style={s.chip(col, on)}
              >
                <span style={s.dot(on ? col : BORDER)} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Weight matrix ───────────────────────────────────────────────── */}
      <div style={s.panel}>
        <div style={s.sectionLabel}>
          Portfolio Weights — latest rebalance per strategy
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
                      <th key={p.id} style={{ ...s.th, color: COLORS[p.id] ?? TEXT_DIM }}>
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
                      const total = weightRows.reduce((s, r) => s + (r[p.id] ?? 0), 0);
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
              Weights as of{' '}
              {(portfolios ?? []).map(p => {
                const d = latestRebalanceDate(p.rebalances);
                return <span key={p.id} style={{ marginRight: 12, color: COLORS[p.id] ?? TEXT_DIM }}>{p.label}: {d ?? '—'}</span>;
              })}
            </div>
          </>
        )}
      </div>

    </div>
  );
}
