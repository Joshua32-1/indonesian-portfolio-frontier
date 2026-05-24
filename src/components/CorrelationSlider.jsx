/**
 * CorrelationSlider.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Dual-label slider that interpolates between the two pre-computed anchor
 * correlation matrices.  Displays a live readout of the current stress-mix
 * percentage and a colour-coded regime label.
 *
 * Props:
 *   stressMix       {number}   — current α ∈ [0, 1]
 *   onStressMixChange {fn}     — callback(newAlpha: number)
 *   matrixA         {number[][]} — Regular correlation matrix (for preview)
 *   matrixB         {number[][]} — Stress  correlation matrix (for preview)
 *   labels          {string[]}   — ticker labels for matrix display
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState } from 'react';

// Colour stops for the regime gradient track
const TRACK_GRADIENT = 'linear-gradient(to right, #00CFFD 0%, #10B981 25%, #F59E0B 60%, #EF4444 100%)';

/** Maps α to a human-readable regime label + accent colour. */
function regimeLabel(alpha) {
  if (alpha < 0.15) return { label: 'BULL MARKET',   color: '#00CFFD', emoji: '🟢' };
  if (alpha < 0.35) return { label: 'MILD STRESS',   color: '#10B981', emoji: '🟡' };
  if (alpha < 0.60) return { label: 'MODERATE BEAR', color: '#F59E0B', emoji: '🟠' };
  if (alpha < 0.80) return { label: 'STRESS REGIME', color: '#F97316', emoji: '🔴' };
  return             { label: 'FULL CRISIS',    color: '#EF4444', emoji: '💀' };
}

/** Blends two numeric values linearly — used for the matrix preview cells. */
const blend = (a, b, alpha) => (1 - alpha) * a + alpha * b;

/** Returns a background colour for a correlation cell on a green→red scale. */
function cellColor(r) {
  const clamped = Math.max(-1, Math.min(1, r));
  if (clamped >= 0) {
    const g = Math.round(207 - clamped * 140);   // #00CF → #006F (teal range)
    return `rgba(0, ${g}, ${Math.round(200 - clamped * 60)}, ${0.15 + clamped * 0.45})`;
  }
  const abs = Math.abs(clamped);
  return `rgba(239, 68, 68, ${0.1 + abs * 0.4})`;
}

export default function CorrelationSlider({
  stressMix,
  onStressMixChange,
  matrixA,
  matrixB,
  labels,
}) {
  const [showMatrix, setShowMatrix] = useState(false);
  const { label, color, emoji } = regimeLabel(stressMix);
  const pct = Math.round(stressMix * 100);

  // Build the live-blended preview matrix (only when panel is open)
  const blendedMatrix = showMatrix && matrixA && matrixB
    ? matrixA.map((row, i) => row.map((v, j) => blend(v, matrixB[i][j], stressMix)))
    : null;

  return (
    <div style={styles.container}>
      {/* ── Header ── */}
      <div style={styles.header}>
        <div>
          <div style={styles.sectionLabel}>REGIME STRESS MIX  ·  α</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            <span style={{ ...styles.pctDisplay, color }}>{pct}%</span>
            <span style={{ fontSize: 10, color, letterSpacing: 1, fontWeight: 700 }}>
              {emoji} {label}
            </span>
          </div>
        </div>
        <button
          style={{ ...styles.matrixToggle, borderColor: color + '55', color }}
          onClick={() => setShowMatrix(s => !s)}
          title="Toggle blended correlation matrix preview"
        >
          {showMatrix ? '▲ HIDE ρ' : '▼ SHOW ρ'}
        </button>
      </div>

      {/* ── Slider track ── */}
      <div style={styles.sliderWrap}>
        <span style={styles.trackLabel}>Regular</span>
        <div style={styles.trackOuter}>
          {/* Coloured fill bar */}
          <div style={{
            ...styles.trackFill,
            width: `${pct}%`,
            background: TRACK_GRADIENT,
          }} />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            onChange={e => onStressMixChange(parseInt(e.target.value, 10) / 100)}
            style={styles.rangeInput}
          />
        </div>
        <span style={styles.trackLabel}>Stress</span>
      </div>

      {/* ── Tick marks ── */}
      <div style={styles.tickRow}>
        {[0, 25, 50, 75, 100].map(v => (
          <button
            key={v}
            style={{ ...styles.tick, color: v === pct ? color : '#334155' }}
            onClick={() => onStressMixChange(v / 100)}
          >
            {v}%
          </button>
        ))}
      </div>

      {/* ── Blended ρ matrix preview (collapsible) ── */}
      {showMatrix && blendedMatrix && (
        <div style={styles.matrixPanel}>
          <div style={styles.sectionLabel}>
            BLENDED CORRELATION MATRIX — α = {stressMix.toFixed(2)}
          </div>
          <div style={{ overflowX: 'auto', marginTop: 6 }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th} />
                  {labels.map(l => <th key={l} style={styles.th}>{l}</th>)}
                </tr>
              </thead>
              <tbody>
                {blendedMatrix.map((row, i) => (
                  <tr key={labels[i]}>
                    <td style={{ ...styles.td, color: '#64748B', fontWeight: 700 }}>
                      {labels[i]}
                    </td>
                    {row.map((r, j) => (
                      <td
                        key={j}
                        style={{
                          ...styles.td,
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
          {/* Legend */}
          <div style={styles.legend}>
            <span style={{ color: '#00CFFD' }}>■ Regular: α=0</span>
            <span style={{ color: color }}>  ■ Blended: α={stressMix.toFixed(2)}</span>
            <span style={{ color: '#EF4444' }}>  ■ Full Stress: α=1</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  container: {
    background: '#07111E',
    border: '1px solid #0F2337',
    borderRadius: 8,
    padding: '14px 16px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  sectionLabel: {
    fontSize: 9,
    color: '#334155',
    letterSpacing: 1.5,
    fontWeight: 700,
    textTransform: 'uppercase',
  },
  pctDisplay: {
    fontSize: 28,
    fontWeight: 800,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: -1,
    lineHeight: 1,
  },
  matrixToggle: {
    background: 'transparent',
    border: '1px solid',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    cursor: 'pointer',
  },
  sliderWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  trackLabel: {
    fontSize: 8,
    color: '#334155',
    letterSpacing: 1,
    flexShrink: 0,
    width: 44,
  },
  trackOuter: {
    position: 'relative',
    flex: 1,
    height: 6,
    background: '#0A1628',
    borderRadius: 3,
    overflow: 'visible',
  },
  trackFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    borderRadius: 3,
    pointerEvents: 'none',
    transition: 'width 0.05s',
  },
  rangeInput: {
    position: 'absolute',
    left: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    width: '100%',
    margin: 0,
    opacity: 0,
    cursor: 'pointer',
    height: 20,
    zIndex: 2,
  },
  tickRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 0,
  },
  tick: {
    background: 'none',
    border: 'none',
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 0.5,
    cursor: 'pointer',
    padding: '2px 0',
    transition: 'color 0.15s',
  },
  matrixPanel: {
    marginTop: 14,
    paddingTop: 12,
    borderTop: '1px solid #0A1628',
  },
  table: {
    borderCollapse: 'collapse',
    fontSize: 10,
    width: '100%',
  },
  th: {
    padding: '3px 6px',
    color: '#334155',
    fontSize: 9,
    fontWeight: 700,
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '4px 6px',
    textAlign: 'center',
    borderRadius: 2,
    fontSize: 10,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  legend: {
    marginTop: 8,
    fontSize: 9,
    color: '#334155',
    letterSpacing: 0.5,
  },
};
