const pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = v => (v == null ? '—' : v.toFixed(2));

const ROWS = [
  { key: 'annReturn', label: 'Ann. return', fmt: pct },
  { key: 'annVol', label: 'Ann. volatility', fmt: pct },
  { key: 'sharpe', label: 'Sharpe', fmt: num },
  { key: 'maxDrawdown', label: 'Max drawdown', fmt: pct },
  { key: 'trackingError', label: 'Tracking error vs IHSG', fmt: pct },
  { key: 'beta', label: 'Beta vs IHSG', fmt: num },
  { key: 'correlation', label: 'Corr vs IHSG', fmt: num },
];

const COLS = [
  { key: 'MinVar', label: 'Min-Var', color: '#10B981' },
  { key: 'EqualWeight', label: 'Equal-Wt', color: '#F59E0B' },
  { key: 'IHSG', label: 'IHSG', color: '#7DA8C7' },
];

export default function MetricsTable({ metrics }) {
  if (!metrics) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
      <thead>
        <tr>
          <th style={{ ...th, textAlign: 'left' }}>Metric</th>
          {COLS.map(c => <th key={c.key} style={{ ...th, color: c.color }}>{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {ROWS.map(r => (
          <tr key={r.key}>
            <td style={{ ...td, textAlign: 'left', color: '#7DA8C7' }}>{r.label}</td>
            {COLS.map(c => (
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
