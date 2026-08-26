/**
 * CorrelationExplorer.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Interactive correlation window picker with:
 *   • Background line chart — all stocks + IHSG (rebased to 100)
 *   • Per-series visibility toggles
 *   • Date range selection driving live ρ matrix used by simulation
 */

import { useMemo, useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  buildIndexedChartData,
  computeCorrelationFromDateRange,
  alignedHistoryRange,
  todayISO,
} from '../math/matrixEngine.js';

const IHSG_COLOR = '#94A3B8';

const TICKER_PALETTE = [
  '#3B82F6', '#10B981', '#8B5CF6', '#EC4899', '#F59E0B',
  '#06B6D4', '#A78BFA', '#EF4444', '#84CC16', '#F97316',
  '#6366F1', '#14B8A6', '#E879F9',
];

function cellColor(r) {
  const clamped = Math.max(-1, Math.min(1, r));
  if (clamped >= 0) {
    const g = Math.round(207 - clamped * 140);
    return `rgba(0, ${g}, ${Math.round(200 - clamped * 60)}, ${0.15 + clamped * 0.45})`;
  }
  const abs = Math.abs(clamped);
  return `rgba(239, 68, 68, ${0.1 + abs * 0.4})`;
}

/** Rows per column before the tooltip flows into another column. One row per series in a
 *  single column grows taller than the plot at ~20 names and hides the very lines you are
 *  hovering to read. */
const TOOLTIP_ROWS_PER_COL = 9;

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  // Sort by value so the list order matches how the lines are stacked at this x — with 25+
  // series, series-declaration order is unscannable.
  const rows = [...payload].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const rowsPerCol = Math.min(rows.length, TOOLTIP_ROWS_PER_COL);
  return (
    <div style={s.tooltip}>
      <div style={{ color: '#64748B', marginBottom: 4 }}>{label}</div>
      {/* Column-major flow: reading down a column keeps the value ordering intact. */}
      <div style={{
        display: 'grid',
        gridAutoFlow: 'column',
        gridTemplateRows: `repeat(${rowsPerCol}, auto)`,
        columnGap: 14,
        rowGap: 1,
      }}>
        {rows.map(p => (
          <div key={p.dataKey} style={{ color: p.color, fontSize: 9, display: 'flex', gap: 10 }}>
            <span style={{ minWidth: 34 }}>{p.dataKey}</span>
            <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
              {p.value?.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CorrelationExplorer({
  assets,
  activeAssets,
  benchmark,
  activeSet,
  sectorColors = {},
  corrStart,
  corrEnd,
  corrStale = false,
  onCorrStartChange,
  onCorrEndChange,
  onRegenerateCorrelation,
}) {
  const [chartVisible, setChartVisible] = useState(() => new Set(['IHSG']));
  const [showMatrix, setShowMatrix] = useState(true);

  // Sync visible lines when assets load (initial state runs before fetch completes)
  useEffect(() => {
    if (!assets.length) return;
    setChartVisible(prev => {
      const next = new Set(prev);
      assets.forEach(a => next.add(a.ticker));
      next.add('IHSG');
      return next;
    });
  }, [assets]);

  const hasPriceHistory = assets.some(a => a.priceHistory?.dates?.length);
  const benchHistory = benchmark?.priceHistory ?? null;
  const activeLabels = useMemo(() => activeAssets.map(a => a.ticker), [activeAssets]);

  const bounds = useMemo(
    () => alignedHistoryRange(activeAssets),
    [activeAssets],
  );

  const chartStart = corrStart;
  const chartEnd = corrEnd;

  const chartData = useMemo(() => {
    if (!hasPriceHistory || !chartStart || !chartEnd || chartStart > chartEnd) return [];
    return buildIndexedChartData(activeAssets, benchHistory, chartStart, chartEnd);
  }, [activeAssets, benchHistory, chartStart, chartEnd, hasPriceHistory]);

  const tickerColors = useMemo(() => {
    const map = {};
    assets.forEach((a, i) => {
      map[a.ticker] = sectorColors[a.sector] ?? TICKER_PALETTE[i % TICKER_PALETTE.length];
    });
    map.IHSG = IHSG_COLOR;
    return map;
  }, [assets, sectorColors]);

  const activeCorr = useMemo(() => {
    if (!hasPriceHistory || activeAssets.length < 2 || !corrStart || !corrEnd || corrStart > corrEnd) {
      return null;
    }
    try {
      return computeCorrelationFromDateRange(activeAssets, corrStart, corrEnd);
    } catch {
      return null;
    }
  }, [activeAssets, corrStart, corrEnd, hasPriceHistory]);

  const toggleChartLine = (key) => {
    setChartVisible(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (key !== 'IHSG' || next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (!hasPriceHistory) {
    return (
      <div style={s.empty}>
        <div style={{ fontSize: 28 }}>📈</div>
        <div style={{ color: '#E2E8F0', fontWeight: 700 }}>Price history not available</div>
        <p style={{ color: '#64748B', margin: 0, lineHeight: 1.6, fontSize: 11 }}>
          Re-run <code style={{ color: '#F59E0B' }}>npm run fetch-snapshot</code> to populate
          weekly price series and IHSG benchmark data.
        </p>
      </div>
    );
  }

  return (
    <div style={s.root}>
      {/* ── Background chart ──────────────────────────────────────────── */}
      <div style={s.chartPanel}>
        <div style={s.chartHeader}>
          <div>
            <div style={s.sectionLabel}>PRICE PERFORMANCE · rebased to 100</div>
            <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>
              {chartStart} → {chartEnd} · weekly adjusted close
            </div>
          </div>
        </div>

        <div style={s.chartWrap}>
          {chartData.length === 0 ? (
            <div style={s.chartEmpty}>No chart data for this date range.</div>
          ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="#0A1628" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fill: '#334155', fontSize: 8 }}
                tickFormatter={d => d?.slice(2, 7)}
                minTickGap={40}
              />
              <YAxis
                tick={{ fill: '#334155', fontSize: 8 }}
                domain={['auto', 'auto']}
                width={42}
                tickFormatter={v => `${v}`}
              />
              <Tooltip content={<ChartTooltip />} />
              {assets.map(a => chartVisible.has(a.ticker) && (
                <Line
                  key={a.ticker}
                  type="monotone"
                  dataKey={a.ticker}
                  stroke={tickerColors[a.ticker]}
                  strokeWidth={activeSet.has(a.ticker) ? 2 : 1.2}
                  dot={false}
                  connectNulls
                  strokeOpacity={activeSet.has(a.ticker) ? 0.95 : 0.45}
                />
              ))}
              {chartVisible.has('IHSG') && (
                <Line
                  type="monotone"
                  dataKey="IHSG"
                  stroke={IHSG_COLOR}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  dot={false}
                  connectNulls
                />
              )}
            </LineChart>
          </ResponsiveContainer>
          )}
        </div>

        {/* Series toggles */}
        <div style={s.legendRow}>
          {assets.map(a => {
            const on = chartVisible.has(a.ticker);
            const col = tickerColors[a.ticker];
            return (
              <button
                key={a.ticker}
                onClick={() => toggleChartLine(a.ticker)}
                style={{
                  ...s.legendChip,
                  borderColor: on ? col + '88' : '#0A1628',
                  background: on ? col + '18' : '#050B17',
                  color: on ? col : '#334155',
                  opacity: activeSet.has(a.ticker) ? 1 : 0.55,
                }}
              >
                <span style={{ ...s.legendDot, background: on ? col : '#1E3A5F' }} />
                {a.ticker}
              </button>
            );
          })}
          <button
            onClick={() => toggleChartLine('IHSG')}
            style={{
              ...s.legendChip,
              borderColor: chartVisible.has('IHSG') ? IHSG_COLOR + '88' : '#0A1628',
              background: chartVisible.has('IHSG') ? '#1E293B' : '#050B17',
              color: chartVisible.has('IHSG') ? IHSG_COLOR : '#334155',
            }}
          >
            <span style={{ ...s.legendDot, background: chartVisible.has('IHSG') ? IHSG_COLOR : '#1E3A5F' }} />
            IHSG
          </button>
        </div>
      </div>

      {/* ── Controls + matrix ─────────────────────────────────────────── */}
      <div style={s.controlPanel}>
        <div style={s.dateRow}>
          <div style={s.dateField}>
            <label style={s.sectionLabel}>CORRELATION START</label>
            <input
              type="date"
              value={corrStart}
              min={bounds?.min}
              max={corrEnd ?? bounds?.max}
              onChange={e => onCorrStartChange(e.target.value)}
              style={s.dateInput}
            />
          </div>
          <div style={s.dateArrow}>→</div>
          <div style={s.dateField}>
            <label style={s.sectionLabel}>CORRELATION END</label>
            <input
              type="date"
              value={corrEnd}
              min={corrStart ?? bounds?.min}
              max={todayISO()}
              onChange={e => onCorrEndChange(e.target.value)}
              style={s.dateInput}
            />
          </div>
          {bounds?.min && (
            <div style={s.presets}>
              <button
                style={s.presetBtn}
                onClick={() => {
                  onCorrStartChange(bounds.min);
                  onCorrEndChange(todayISO());
                }}
              >
                Max range
              </button>
            </div>
          )}
        </div>

        <div style={s.metaRow}>
          {corrStale && (
            <span style={{ color: '#F59E0B', fontSize: 9, fontWeight: 700 }}>
              Active universe changed — regenerate to expand date range
            </span>
          )}
          <span style={{ color: '#00CFFD', fontSize: 10 }}>
            ● Simulation uses ρ from {corrStart} → {corrEnd}
          </span>
          {activeCorr && (
            <span style={{ color: '#64748B', fontSize: 9 }}>
              {activeCorr.obs} weekly returns · {activeCorr.labels.length} active assets
              {bounds && ` · aligned ${bounds.min} → ${bounds.max}`}
            </span>
          )}
          <div style={s.metaActions}>
            <button
              style={{
                ...s.regenCorrBtn,
                opacity: activeAssets.length < 2 ? 0.45 : 1,
                cursor: activeAssets.length < 2 ? 'not-allowed' : 'pointer',
              }}
              disabled={activeAssets.length < 2}
              onClick={onRegenerateCorrelation}
              title="Re-align correlation window to active assets (drops short-history exclusions)"
            >
              ⟳ REGENERATE CORRELATION
            </button>
            <button
              style={s.matrixToggle}
              onClick={() => setShowMatrix(v => !v)}
            >
              {showMatrix ? '▲ HIDE ρ' : '▼ SHOW ρ'}
            </button>
          </div>
        </div>

        {showMatrix && activeCorr && (
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th} />
                  {activeCorr.labels.map(l => (
                    <th key={l} style={{ ...s.th, color: tickerColors[l] }}>{l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeCorr.matrix.map((row, i) => (
                  <tr key={activeCorr.labels[i]}>
                    <td style={{ ...s.td, color: tickerColors[activeCorr.labels[i]], fontWeight: 700 }}>
                      {activeCorr.labels[i]}
                    </td>
                    {row.map((r, j) => (
                      <td
                        key={j}
                        style={{
                          ...s.td,
                          background: cellColor(r),
                          color: i === j ? '#FFD700' : '#E2E8F0',
                        }}
                      >
                        {r.toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeLabels.length < 2 && (
          <div style={{ fontSize: 9, color: '#F59E0B', marginTop: 8 }}>
            Enable at least 2 assets in Workspace to preview the active correlation matrix.
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  root: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 520 },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    minHeight: 400, gap: 12, textAlign: 'center', padding: 24,
  },
  chartPanel: {
    background: '#07111E',
    border: '1px solid #0F2337',
    borderRadius: 8,
    padding: '14px 16px',
    flex: 1,
    minHeight: 340,
    display: 'flex',
    flexDirection: 'column',
  },
  chartHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
    gap: 12,
    flexWrap: 'wrap',
  },
  sectionLabel: {
    fontSize: 9,
    color: '#334155',
    letterSpacing: 1.5,
    fontWeight: 700,
    textTransform: 'uppercase',
  },
  chartWrap: { height: 300, marginBottom: 10 },
  chartEmpty: {
    height: 300,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#475569',
    fontSize: 11,
    background: '#050B17',
    borderRadius: 6,
    border: '1px dashed #0A1628',
  },
  legendRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  legendChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 8px',
    borderRadius: 4,
    border: '1px solid',
    fontSize: 9,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  legendDot: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },
  controlPanel: {
    background: '#07111E',
    border: '1px solid #0F2337',
    borderRadius: 8,
    padding: '14px 16px',
  },
  dateRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 12,
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  dateField: { display: 'flex', flexDirection: 'column', gap: 4 },
  dateInput: {
    background: '#050D1A',
    border: '1px solid #1E3A5F',
    borderRadius: 4,
    padding: '6px 10px',
    color: '#E2E8F0',
    fontSize: 11,
    fontFamily: 'inherit',
    outline: 'none',
  },
  dateArrow: { color: '#334155', fontSize: 16, paddingBottom: 6 },
  presets: { display: 'flex', gap: 4, alignItems: 'flex-end', flexWrap: 'wrap' },
  presetBtn: {
    background: '#050B17',
    border: '1px solid #0A1628',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 8,
    fontWeight: 700,
    color: '#64748B',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  metaActions: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  matrixToggle: {
    background: 'transparent',
    border: '1px solid #1E3A5F',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 9,
    fontWeight: 700,
    color: '#64748B',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  regenCorrBtn: {
    background: 'linear-gradient(135deg,#0F2337,#1E3A5F)',
    border: '1px solid #00CFFD44',
    borderRadius: 4,
    padding: '5px 12px',
    fontSize: 9,
    fontWeight: 800,
    color: '#00CFFD',
    cursor: 'pointer',
    fontFamily: 'inherit',
    letterSpacing: 0.5,
  },
  table: { borderCollapse: 'collapse', fontSize: 10, width: '100%' },
  th: {
    padding: '4px 6px',
    fontSize: 9,
    fontWeight: 700,
    textAlign: 'center',
    color: '#334155',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '4px 6px',
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  tooltip: {
    background: '#07111E',
    border: '1px solid #1E3A5F',
    borderRadius: 6,
    padding: '8px 10px',
    fontFamily: 'monospace',
    fontSize: 10,
  },
};
