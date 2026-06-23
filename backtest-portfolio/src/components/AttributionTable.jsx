import { formatRiskContributionPct } from '../../../portfolio-app/src/math/matrixEngine.js';

const pct1 = v => `${(v * 100).toFixed(1)}%`;
const signed = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

/** Diverging bar: width ∝ |value|/max, green for gains / teal for risk, red for negatives. */
function Bar({ value, max, posColor }) {
  const w = max > 0 ? Math.min(100, (Math.abs(value) / max) * 100) : 0;
  return (
    <div style={{ height: 6, background: '#102438', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${w}%`, height: '100%', background: value >= 0 ? posColor : '#F87171' }} />
    </div>
  );
}

/**
 * Per-stock return + risk attribution table for the selected portfolio.
 * @param {Array} rows  [{ ticker, avgWeight, returnContrib, returnShare, riskContrib }] (sorted desc by returnContrib)
 */
export default function AttributionTable({ rows }) {
  if (!rows?.length) return null;
  const maxRet = Math.max(1e-9, ...rows.map(r => Math.abs(r.returnContrib)));
  const maxRC = Math.max(1e-9, ...rows.map(r => Math.abs(r.riskContrib)));

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>
          <th style={{ ...th, textAlign: 'left' }}>Stock</th>
          <th style={th}>Avg wt</th>
          <th style={{ ...th, minWidth: 150 }}>Return contribution</th>
          <th style={{ ...th, minWidth: 150 }}>Risk contribution</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.ticker}>
            <td style={{ ...td, textAlign: 'left', fontFamily: 'monospace', fontWeight: 700, color: '#E2E8F0' }}>{r.ticker}</td>
            <td style={{ ...td, fontFamily: 'monospace', color: '#7DA8C7' }}>{pct1(r.avgWeight)}</td>
            <td style={td}>
              <div style={cellRow}>
                <span style={{ fontFamily: 'monospace', width: 64, textAlign: 'right', color: r.returnContrib >= 0 ? '#34D399' : '#F87171' }}>
                  {signed(r.returnContrib)}
                </span>
                <div style={{ flex: 1 }}><Bar value={r.returnContrib} max={maxRet} posColor="#10B981" /></div>
              </div>
            </td>
            <td style={td}>
              <div style={cellRow}>
                <span style={{ fontFamily: 'monospace', width: 56, textAlign: 'right', color: r.riskContrib >= 0 ? '#7DA8C7' : '#F87171' }}>
                  {formatRiskContributionPct(r.riskContrib)}
                </span>
                <div style={{ flex: 1 }}><Bar value={r.riskContrib} max={maxRC} posColor="#7DA8C7" /></div>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th = { padding: '6px 8px', borderBottom: '1px solid #1E3A5F', fontSize: 11, fontWeight: 700, textAlign: 'right', color: '#7DA8C7' };
const td = { padding: '5px 8px', borderBottom: '1px solid #102438', textAlign: 'right' };
const cellRow = { display: 'flex', alignItems: 'center', gap: 8 };
