const pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = v => (v == null ? '—' : v.toFixed(2));
const ratio = v => (v == null ? '—' : `${v.toFixed(1)}×`);

const ROWS = [
  { key: 'annReturn', label: 'Ann. return (net)', fmt: pct },
  { key: 'annVol', label: 'Ann. volatility', fmt: pct },
  { key: 'sharpe', label: 'Sharpe (net)', fmt: num },
  { key: 'grossSharpe', label: 'Sharpe (gross)', fmt: num },
  { key: 'maxDrawdown', label: 'Max drawdown', fmt: pct },
  { key: 'infoRatio', label: 'Info ratio vs IHSG', fmt: num },
  { key: 'tStat', label: 't-stat of alpha', fmt: num },
  { key: 'hitRate', label: 'Hit rate vs IHSG', fmt: pct },
  { key: 'trackingError', label: 'Tracking error vs IHSG', fmt: pct },
  { key: 'beta', label: 'Beta vs IHSG', fmt: num },
  { key: 'annualTurnover', label: 'Turnover / yr', fmt: ratio },
  { key: 'annualCostDrag', label: 'Cost drag / yr', fmt: pct },
];

const DEFAULT_COLS = [
  { key: 'MinVar', label: 'Min-Var', color: '#10B981' },
  { key: 'EqualWeight', label: 'Equal-Wt', color: '#F59E0B' },
  { key: 'IHSG', label: 'IHSG', color: '#7DA8C7' },
];

export default function MetricsTable({ metrics, cols = DEFAULT_COLS }) {
  if (!metrics) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
      <thead>
        <tr>
          <th style={{ ...th, textAlign: 'left' }}>Metric</th>
          {cols.map(c => <th key={c.key} style={{ ...th, color: c.color }}>{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {ROWS.map(r => (
          <tr key={r.key}>
            <td style={{ ...td, textAlign: 'left', color: '#7DA8C7' }}>{r.label}</td>
            {cols.map(c => (
              <td key={c.key} style={{ ...td, fontFamily: 'monospace', color: '#E2E8F0' }}>
                {r.fmt(metrics[c.key]?.[r.key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th = { padding: '6px 8px', borderBottom: '1px solid #1E3A5F', fontSize: 11, fontWeight: 700, textAlign: 'right' };
const td = { padding: '5px 8px', borderBottom: '1px solid #102438', textAlign: 'right' };
