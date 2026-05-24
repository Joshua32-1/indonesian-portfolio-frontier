/**
 * PortfolioWeights.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders a data-table for portfolio weight allocation.
 * Each row contains:
 *   • Ticker / sector badge
 *   • Analyst consensus forward target (low → mean → high price range)
 *   • Editable weight input  (percentage, sums validated live)
 *   • Days-to-Expiry (DTE) input — feeds the theta-decay calculation
 *   • Current σ_daily and decayed σ (read-only diagnostics)
 *
 * Props:
 *   assets          {Asset[]}       — full asset array from snapshot
 *   weights         {Object}        — { [ticker]: number }  (0–100 scale)
 *   daysToExpiry    {number}        — single shared DTE value
 *   decayedVols     {number[]}      — σ_decayed per asset from matrixEngine
 *   onWeightChange  {fn(ticker, newPct: number)}
 *   onDteChange     {fn(newDays: number)}
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SECTOR_COLORS = {
  Banking:     '#3B82F6',
  Telecoms:    '#10B981',
  Conglomerate:'#8B5CF6',
  Transport:   '#EC4899',
  Consumer:    '#84CC16',
  IDX:         '#F59E0B',
};

/** Formats a price to a compact IDR string. */
const fmtIDR = p => p == null ? '—' : `${(p / 1000).toFixed(1)}k`;

/** Returns upside/downside % from current price to a target. */
const upside = (target, current) =>
  current ? `${((target - current) / current * 100).toFixed(1)}%` : '—';

export default function PortfolioWeights({
  assets,
  weights,
  daysToExpiry,
  decayedVols,
  onWeightChange,
  onDteChange,
}) {
  // Live sum of all weights for validation indicator
  const totalWeight = Object.values(weights).reduce((s, v) => s + (parseFloat(v) || 0), 0);
  const sumOk = Math.abs(totalWeight - 100) < 0.5;

  const handleNormalize = () => {
    if (totalWeight === 0) return;
    assets.forEach(a => {
      const raw = parseFloat(weights[a.ticker]) || 0;
      onWeightChange(a.ticker, +((raw / totalWeight) * 100).toFixed(2));
    });
  };

  const handleEqualWeight = () => {
    const eq = +(100 / assets.length).toFixed(2);
    assets.forEach(a => onWeightChange(a.ticker, eq));
  };

  return (
    <div style={styles.container}>
      {/* ── Header bar ── */}
      <div style={styles.headerRow}>
        <div>
          <div style={styles.sectionLabel}>PORTFOLIO ALLOCATION</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span style={{
              fontSize: 20, fontWeight: 800,
              color: sumOk ? '#00FF88' : '#EF4444',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {totalWeight.toFixed(1)}%
            </span>
            <span style={{ fontSize: 9, color: sumOk ? '#10B981' : '#EF4444', fontWeight: 700 }}>
              {sumOk ? '✓ VALID' : '⚠ MUST SUM TO 100'}
            </span>
          </div>
        </div>
        <div style={styles.btnGroup}>
          <button style={styles.btn} onClick={handleEqualWeight}>EW</button>
          <button style={styles.btn} onClick={handleNormalize}>NORM</button>
        </div>
      </div>

      {/* ── DTE control ── */}
      <div style={styles.dteRow}>
        <span style={styles.sectionLabel}>DAYS TO EXPIRY (DTE)</span>
        <div style={styles.dteInputWrap}>
          <input
            type="number"
            min={1}
            max={365}
            step={1}
            value={daysToExpiry}
            onChange={e => onDteChange(Math.max(1, parseInt(e.target.value, 10) || 1))}
            style={styles.dteInput}
          />
          <span style={styles.dteUnit}>d</span>
        </div>
        <div style={styles.dteMeta}>
          T = {(daysToExpiry / 365).toFixed(3)} yr
          &nbsp;·&nbsp;
          √T = {Math.sqrt(daysToExpiry / 365).toFixed(3)}
        </div>
      </div>

      {/* ── Asset table ── */}
      <div style={styles.tableWrap}>
        {/* Column headers */}
        <div style={styles.colHeader}>
          <span style={{ width: 72 }}>ASSET</span>
          <span style={{ flex: 1, textAlign: 'right' }}>TARGETS (IDR)</span>
          <span style={{ width: 66, textAlign: 'right' }}>σ_decay</span>
          <span style={{ width: 68, textAlign: 'right' }}>WEIGHT</span>
        </div>

        {/* Rows */}
        {assets.map((asset, idx) => {
          const { ticker, sector, meta, forwardEstimates: fe } = asset;
          const sectorColor = SECTOR_COLORS[sector] ?? '#64748B';
          const w = parseFloat(weights[ticker]) || 0;
          const decVol = decayedVols?.[idx];
          const upPct = fe.meanTarget && meta.currentPrice
            ? ((fe.meanTarget - meta.currentPrice) / meta.currentPrice * 100)
            : 0;

          return (
            <div key={ticker} style={styles.row}>
              {/* Ticker + sector */}
              <div style={{ width: 72 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: sectorColor, flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: sectorColor }}>
                    {ticker}
                  </span>
                </div>
                <div style={{ fontSize: 8, color: '#334155', marginLeft: 11, marginTop: 1 }}>
                  {sector}
                </div>
              </div>

              {/* Analyst target range */}
              <div style={{ flex: 1, textAlign: 'right' }}>
                <div style={styles.targetBar}>
                  {/* Range visualiser */}
                  <div style={styles.rangeViz}>
                    <span style={{ fontSize: 8, color: '#EF4444' }}>
                      {fmtIDR(fe.lowTarget)}
                    </span>
                    <div style={styles.rangeTrack}>
                      <div style={{
                        position: 'absolute',
                        left: '0%', right: '0%',
                        height: '100%',
                        background: '#0F2337',
                        borderRadius: 2,
                      }} />
                      {/* Current price marker */}
                      {fe.highTarget && fe.lowTarget && meta.currentPrice && (
                        <div style={{
                          position: 'absolute',
                          left: `${Math.max(0, Math.min(100,
                            (meta.currentPrice - fe.lowTarget) / (fe.highTarget - fe.lowTarget) * 100
                          ))}%`,
                          width: 2, height: '100%',
                          background: '#64748B',
                        }} />
                      )}
                      {/* Mean marker */}
                      {fe.highTarget && fe.lowTarget && fe.meanTarget && (
                        <div style={{
                          position: 'absolute',
                          left: `${Math.max(0, Math.min(100,
                            (fe.meanTarget - fe.lowTarget) / (fe.highTarget - fe.lowTarget) * 100
                          ))}%`,
                          width: 2, height: '100%',
                          background: upPct >= 0 ? '#00FF88' : '#EF4444',
                        }} />
                      )}
                    </div>
                    <span style={{ fontSize: 8, color: '#10B981' }}>
                      {fmtIDR(fe.highTarget)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                    <span style={{ fontSize: 8, color: '#475569' }}>
                      μ̂ {fmtIDR(fe.meanTarget)}
                    </span>
                    <span style={{
                      fontSize: 8, fontWeight: 700,
                      color: upPct >= 0 ? '#00FF88' : '#EF4444',
                    }}>
                      {upPct >= 0 ? '+' : ''}{upPct.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>

              {/* σ_decayed diagnostic */}
              <div style={{ width: 66, textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: '#F59E0B', fontVariantNumeric: 'tabular-nums' }}>
                  {decVol != null ? `${(decVol * 100).toFixed(2)}%` : '—'}
                </div>
                <div style={{ fontSize: 8, color: '#334155' }}>
                  σ {(meta.recentDailyVol * 100).toFixed(2)}%
                </div>
              </div>

              {/* Weight input */}
              <div style={{ width: 68, textAlign: 'right' }}>
                <div style={styles.weightInputWrap}>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={weights[ticker] ?? ''}
                    onChange={e => onWeightChange(ticker, parseFloat(e.target.value) || 0)}
                    style={{
                      ...styles.weightInput,
                      borderColor: w > 0 ? sectorColor + '55' : '#0A1628',
                      color: w > 0 ? sectorColor : '#475569',
                    }}
                  />
                  <span style={{ fontSize: 9, color: '#475569' }}>%</span>
                </div>
                {/* Mini allocation bar */}
                <div style={styles.allocBar}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min(w, 100)}%`,
                    background: sectorColor,
                    opacity: 0.6,
                    borderRadius: 1,
                    transition: 'width 0.15s',
                  }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Analyst summary footer ── */}
      <div style={styles.footer}>
        <span>
          {assets.reduce((s, a) => s + (a.forwardEstimates.totalAnalysts ?? 0), 0)} total analyst opinions
        </span>
        <span>{assets.length} assets</span>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  container: {
    background: '#07111E',
    border: '1px solid #0F2337',
    borderRadius: 8,
    overflow: 'hidden',
  },
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '12px 14px 8px',
    borderBottom: '1px solid #0A1628',
  },
  sectionLabel: {
    fontSize: 9,
    color: '#334155',
    letterSpacing: 1.5,
    fontWeight: 700,
    textTransform: 'uppercase',
  },
  btnGroup: {
    display: 'flex',
    gap: 6,
  },
  btn: {
    background: '#0A1628',
    border: '1px solid #1E3A5F',
    borderRadius: 4,
    padding: '4px 9px',
    fontSize: 9,
    color: '#64748B',
    cursor: 'pointer',
    fontWeight: 700,
    letterSpacing: 1,
  },
  dteRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 14px',
    borderBottom: '1px solid #0A1628',
    background: '#050D1A',
  },
  dteInputWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    background: '#0A1628',
    border: '1px solid #1E3A5F',
    borderRadius: 4,
    padding: '3px 8px',
  },
  dteInput: {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: '#FFD700',
    fontSize: 14,
    fontWeight: 800,
    width: 46,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  dteUnit: {
    fontSize: 10,
    color: '#475569',
    fontWeight: 700,
  },
  dteMeta: {
    fontSize: 8,
    color: '#334155',
    letterSpacing: 0.5,
  },
  tableWrap: {
    padding: '6px 8px',
  },
  colHeader: {
    display: 'flex',
    gap: 8,
    padding: '4px 6px',
    fontSize: 8,
    color: '#1E3A5F',
    letterSpacing: 1,
    fontWeight: 700,
    textTransform: 'uppercase',
    borderBottom: '1px solid #0A1628',
    marginBottom: 4,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px',
    borderRadius: 5,
    marginBottom: 2,
    background: '#070F1D',
    border: '1px solid transparent',
    transition: 'border-color 0.15s',
  },
  targetBar: {
    width: '100%',
  },
  rangeViz: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  rangeTrack: {
    flex: 1,
    height: 4,
    background: '#0F2337',
    borderRadius: 2,
    position: 'relative',
  },
  weightInputWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    justifyContent: 'flex-end',
  },
  weightInput: {
    background: '#050D1A',
    border: '1px solid',
    borderRadius: 3,
    padding: '2px 4px',
    fontSize: 12,
    fontWeight: 700,
    width: 46,
    textAlign: 'right',
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
  },
  allocBar: {
    height: 2,
    background: '#0A1628',
    borderRadius: 1,
    marginTop: 3,
    overflow: 'hidden',
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 14px',
    borderTop: '1px solid #0A1628',
    fontSize: 8,
    color: '#1E3A5F',
    letterSpacing: 1,
  },
};
