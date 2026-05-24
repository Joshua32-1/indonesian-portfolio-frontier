/**
 * EfficientFrontier.jsx  — REFACTORED v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Key changes from v1:
 *   • Axes use data-driven dynamic domains — no hardcoded limits.
 *   • Cloud points rendered via Recharts <Scatter shape={…}> with a closure-
 *     based custom dot component (clean, no Customized hack needed).
 *   • Returns and risk are displayed in annualised % (e.g. 18.5%, 22.3%).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';

// ── Sharpe colour map  ────────────────────────────────────────────────────────

/**
 * Maps a normalised value t ∈ [0,1] to a hex colour.
 * Palette:  cold blue (#3B82F6)  →  amber (#F59E0B)  →  emerald (#00FF88)
 */
function sharpeColor(t) {
  const v = Math.max(0, Math.min(1, t));
  if (v < 0.5) {
    const f = v / 0.5;
    return `rgb(${Math.round(59+f*186)},${Math.round(130+f*28)},${Math.round(246-f*235)})`;
  }
  const f = (v - 0.5) / 0.5;
  return `rgb(${Math.round(245-f*245)},${Math.round(158+f*97)},${Math.round(11-f*11)})`;
}

// ── Custom dot shape (closure captures sharpe metadata) ──────────────────────

function makeCloudDot(sharpeMin, sharpeRange) {
  return function CloudDot(props) {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null) return null;
    const norm = sharpeRange > 0 ? (payload.s - sharpeMin) / sharpeRange : 0.5;
    return <circle cx={cx} cy={cy} r={2} fill={sharpeColor(norm)} opacity={0.55} />;
  };
}

function StarDot(props) {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  const r1 = 9, r2 = 4, pts = 6;
  const path = Array.from({ length: pts * 2 }, (_, i) => {
    const ang = (i * Math.PI) / pts - Math.PI / 2;
    const r   = i % 2 === 0 ? r1 : r2;
    return `${cx + r * Math.cos(ang)},${cy + r * Math.sin(ang)}`;
  }).join(' ');
  return <polygon points={path} fill="#FFD700" stroke="#000" strokeWidth={0.8} />;
}

function DiamondDot(props) {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  const s = 8;
  return (
    <polygon
      points={`${cx},${cy-s} ${cx+s},${cy} ${cx},${cy+s} ${cx-s},${cy}`}
      fill="#00CFFD" stroke="#000" strokeWidth={0.8}
    />
  );
}

// ── Custom Tooltip  ───────────────────────────────────────────────────────────

function FrontierTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div style={{
      background: '#07111E', border: '1px solid #1E3A5F',
      borderRadius: 6, padding: '8px 12px', fontSize: 10,
      fontFamily: 'monospace',
    }}>
      <div style={{ color: '#475569', letterSpacing: 1, marginBottom: 4 }}>PORTFOLIO</div>
      <div>Risk σ:&nbsp;
        <b style={{ color: '#00CFFD' }}>{d.x?.toFixed(2)}%</b>
      </div>
      <div>Return μ:&nbsp;
        <b style={{ color: d.y >= 0 ? '#00FF88' : '#EF4444' }}>{d.y?.toFixed(2)}%</b>
      </div>
      {d.s != null && (
        <div>Sharpe:&nbsp;
          <b style={{ color: '#FFD700' }}>{d.s?.toFixed(3)}</b>
        </div>
      )}
    </div>
  );
}

// ── Main Component  ───────────────────────────────────────────────────────────

export default function EfficientFrontier({ simulationResult, isRunning, stressMix }) {
  // ── Derived data ───────────────────────────────────────────────────────────
  const { cloudData, specialData, domainX, domainY, sharpeMin, sharpeRange } = useMemo(() => {
    if (!simulationResult) return {};

    const { portfolios, maxSharpePortfolio: msp, minVariancePortfolio: mvp } = simulationResult;

    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    let sMin = Infinity, sMax = -Infinity;

    const cloud = portfolios.map(p => {
      const x = p.portfolioRisk   * 100;
      const y = p.portfolioReturn * 100;
      const s = p.portfolioSharpe;
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      if (s < sMin) sMin = s; if (s > sMax) sMax = s;
      return { x, y, s };
    });

    // Axis padding: 8% of range on each side
    const xPad = (xMax - xMin) * 0.08 + 0.5;
    const yPad = (yMax - yMin) * 0.08 + 0.5;

    return {
      cloudData: cloud,
      specialData: {
        maxSharpe: [{ x: msp.portfolioRisk * 100, y: msp.portfolioReturn * 100, s: msp.portfolioSharpe }],
        minVar:    [{ x: mvp.portfolioRisk * 100, y: mvp.portfolioReturn * 100, s: mvp.portfolioSharpe }],
      },
      domainX: [+(xMin - xPad).toFixed(2), +(xMax + xPad).toFixed(2)],
      domainY: [+(yMin - yPad).toFixed(2), +(yMax + yPad).toFixed(2)],
      sharpeMin: sMin,
      sharpeRange: sMax - sMin,
    };
  }, [simulationResult]);

  // Memoize the cloud dot renderer so it isn't re-created on each render
  const CloudDot = useMemo(
    () => (sharpeMin != null ? makeCloudDot(sharpeMin, sharpeRange) : null),
    [sharpeMin, sharpeRange]
  );

  // Stress colour for badge
  const stressColor = stressMix < 0.3 ? '#00CFFD' : stressMix < 0.6 ? '#F59E0B' : '#EF4444';
  const { maxSharpePortfolio: msp, minVariancePortfolio: mvp } = simulationResult ?? {};

  return (
    <div style={s.container}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <div style={s.title}>EFFICIENT FRONTIER CLOUD</div>
          <div style={s.subtitle}>
            {simulationResult
              ? `${simulationResult.portfolios.length.toLocaleString()} paths · Beta-PERT analyst sampling · Annualised σ`
              : 'Run simulation to populate cloud'}
          </div>
        </div>
        <div style={s.badges}>
          <span style={{ ...s.badge, borderColor: stressColor + '55', color: stressColor }}>
            α={stressMix.toFixed(2)} STRESS
          </span>
          {msp && (
            <span style={{ ...s.badge, borderColor: '#FFD70055', color: '#FFD700' }}>
              ★ SR {msp.portfolioSharpe.toFixed(3)}
            </span>
          )}
          {mvp && (
            <span style={{ ...s.badge, borderColor: '#00CFFD55', color: '#00CFFD' }}>
              ◆ σ {(mvp.portfolioRisk * 100).toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      {/* Chart area */}
      <div style={{ position: 'relative', height: 440 }}>
        {isRunning && (
          <div style={s.overlay}>
            <div style={s.spinner} />
            <span style={{ color: '#475569', fontSize: 11, marginTop: 12 }}>Running 5,500 iterations…</span>
          </div>
        )}
        {!simulationResult && !isRunning && (
          <div style={s.empty}>
            <div style={{ fontSize: 36, color: '#0F2337' }}>◈</div>
            <div style={{ color: '#1E3A5F', fontSize: 11, marginTop: 10 }}>No simulation data</div>
          </div>
        )}
        {simulationResult && CloudDot && (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 18, right: 28, bottom: 36, left: 28 }}>
              <CartesianGrid stroke="#0A1628" strokeDasharray="3 3" />

              <XAxis
                type="number"
                dataKey="x"
                name="Risk"
                domain={domainX}
                tickFormatter={v => `${v.toFixed(1)}%`}
                tick={{ fill: '#334155', fontSize: 9, fontFamily: 'monospace' }}
                label={{ value: 'Portfolio Risk σ (annualised %)', position: 'insideBottom', offset: -20, fill: '#334155', fontSize: 9 }}
                stroke="#0F2337"
              />
              <YAxis
                type="number"
                dataKey="y"
                name="Return"
                domain={domainY}
                tickFormatter={v => `${v.toFixed(1)}%`}
                tick={{ fill: '#334155', fontSize: 9, fontFamily: 'monospace' }}
                label={{ value: 'Return μ (%)', angle: -90, position: 'insideLeft', offset: 14, fill: '#334155', fontSize: 9 }}
                stroke="#0F2337"
              />

              <Tooltip content={<FrontierTooltip />} cursor={{ stroke: '#1E3A5F', strokeWidth: 1 }} />

              {/* Sharpe = 0 reference line (return = risk-free rate) */}
              <ReferenceLine y={5.25} stroke="#1E3A5F55" strokeDasharray="6 3" label={{ value: 'RF 5.25%', fill: '#1E3A5F', fontSize: 8, position: 'right' }} />

              {/* Portfolio cloud — 5500 Sharpe-heat coloured dots */}
              <Scatter
                name="Simulated Portfolios"
                data={cloudData}
                shape={<CloudDot />}
                legendType="none"
              />

              {/* Min Variance highlight */}
              <Scatter
                name="Min Variance"
                data={specialData.minVar}
                shape={<DiamondDot />}
                legendType="diamond"
              />

              {/* Max Sharpe highlight */}
              <Scatter
                name="Max Sharpe"
                data={specialData.maxSharpe}
                shape={<StarDot />}
                legendType="star"
              />
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Colour legend */}
      <div style={s.legend}>
        <span style={{ color: '#3B82F6', fontSize: 11 }}>■</span>
        <div style={s.legendBar} />
        <span style={{ color: '#00FF88', fontSize: 11 }}>■</span>
        <span style={{ fontSize: 8, color: '#334155', marginLeft: 6 }}>
          Sharpe ratio heat-map  (blue = low → green = high)
        </span>
        <span style={{ color: '#FFD700', marginLeft: 12, fontSize: 10 }}>★ Max Sharpe</span>
        <span style={{ color: '#00CFFD', marginLeft: 10, fontSize: 10 }}>◆ Min Variance</span>
      </div>
    </div>
  );
}

const s = {
  container: { background: '#07111E', border: '1px solid #0F2337', borderRadius: 8, overflow: 'hidden' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 18px 10px', borderBottom: '1px solid #0A1628' },
  title: { fontSize: 11, color: '#E2E8F0', fontWeight: 800, letterSpacing: 2 },
  subtitle: { fontSize: 9, color: '#334155', marginTop: 3 },
  badges: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' },
  badge: { border: '1px solid', borderRadius: 3, padding: '2px 7px', fontSize: 8, fontWeight: 700, letterSpacing: 1 },
  overlay: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(7,17,30,0.88)', zIndex: 10 },
  spinner: { width: 28, height: 28, border: '3px solid #0F2337', borderTopColor: '#00CFFD', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  empty: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
  legend: { display: 'flex', alignItems: 'center', gap: 4, padding: '8px 16px 12px', borderTop: '1px solid #0A1628' },
  legendBar: { width: 100, height: 4, borderRadius: 2, background: 'linear-gradient(to right, #3B82F6, #F59E0B, #00FF88)' },
};