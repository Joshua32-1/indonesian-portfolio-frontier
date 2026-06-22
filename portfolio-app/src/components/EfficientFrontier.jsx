/**
 * EfficientFrontier.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Three cloud/overlay layers:
 *   • Purple (transparent) — per-scenario optimal max-Sharpe portfolios
 *   • Sharpe heat-map      — fixed robust weights under each analyst scenario
 *   • Robustness frontier  — 7-point λ sweep overlay line
 * Markers: ★ Robust  ▲ Oracle Sharpe  ◆ Min Variance  ◎ Consensus
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react';
import { sharpeRatio } from '../math/matrixEngine.js';
import { DEFAULT_TAIL_PENALTY } from '../math/simConfig.js';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';

function sharpeColor(t) {
  const v = Math.max(0, Math.min(1, t));
  if (v < 0.5) {
    const f = v / 0.5;
    return `rgb(${Math.round(59+f*186)},${Math.round(130+f*28)},${Math.round(246-f*235)})`;
  }
  const f = (v - 0.5) / 0.5;
  return `rgb(${Math.round(245-f*245)},${Math.round(158+f*97)},${Math.round(11-f*11)})`;
}

function makeCloudDot(sharpeMin, sharpeRange) {
  return function CloudDot(props) {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null) return null;
    const norm = sharpeRange > 0 ? (payload.s - sharpeMin) / sharpeRange : 0.5;
    return <circle cx={cx} cy={cy} r={2} fill={sharpeColor(norm)} opacity={0.5} />;
  };
}

function OptimaDot(props) {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  return <circle cx={cx} cy={cy} r={1.2} fill="#A78BFA" opacity={0.22} />;
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

function BestSharpeDot(props) {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  const s = 8;
  return (
    <polygon
      points={`${cx},${cy - s} ${cx + s},${cy + s} ${cx - s},${cy + s}`}
      fill="#FF2D6F"
      stroke="#000"
      strokeWidth={0.8}
    />
  );
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

function ConsensusDot(props) {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  return <circle cx={cx} cy={cy} r={7} fill="#10B981" stroke="#000" strokeWidth={0.8} />;
}

function FrontierLineDot(props) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  const isActive = payload?.isActive;
  return <circle cx={cx} cy={cy} r={isActive ? 5 : 3} fill={payload?.color ?? '#888'} opacity={0.9} stroke="#000" strokeWidth={0.5} />;
}

function FrontierTooltip({ active, payload, riskFreeRate = 0.0575 }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const mu = (d.y ?? 0) / 100;
  const sigma = (d.x ?? 0) / 100;
  const excessPct = (mu - riskFreeRate) * 100;
  const sharpe = sharpeRatio(mu, sigma, riskFreeRate);
  return (
    <div style={{
      background: '#07111E', border: '1px solid #1E3A5F',
      borderRadius: 6, padding: '8px 12px', fontSize: 10,
      fontFamily: 'monospace',
    }}>
      {d.layer && (
        <div style={{ color: '#64748B', letterSpacing: 1, marginBottom: 4 }}>{d.layer}</div>
      )}
      <div>Risk σ:&nbsp;
        <b style={{ color: '#00CFFD' }}>{d.x?.toFixed(2)}%</b>
      </div>
      <div>Return μ:&nbsp;
        <b style={{ color: d.y >= 0 ? '#00FF88' : '#EF4444' }}>{d.y?.toFixed(2)}%</b>
      </div>
      <div>Excess (μ−rf):&nbsp;
        <b style={{ color: excessPct >= 0 ? '#94A3B8' : '#EF4444' }}>{excessPct >= 0 ? '+' : ''}{excessPct.toFixed(2)}%</b>
      </div>
      {sigma > 0 && (
        <div>Sharpe (excess/σ):&nbsp;
          <b style={{ color: '#FFD700' }}>{sharpe.toFixed(3)}</b>
        </div>
      )}
    </div>
  );
}

function toChartPoint(p, layer) {
  return {
    x: p.portfolioRisk * 100,
    y: p.portfolioReturn * 100,
    s: p.portfolioSharpe,
    layer,
  };
}

function extendDomain(xMin, xMax, yMin, yMax, points) {
  for (const pt of points) {
    if (pt.x < xMin) xMin = pt.x;
    if (pt.x > xMax) xMax = pt.x;
    if (pt.y < yMin) yMin = pt.y;
    if (pt.y > yMax) yMax = pt.y;
  }
  return { xMin, xMax, yMin, yMax };
}

// Hue-based gradient: λ=0 (green) → λ=1 (red)
function lambdaColor(lambda) {
  const r = Math.round(34 + lambda * 239);
  const g = Math.round(197 - lambda * 163);
  return `rgb(${r},${g},50)`;
}

export default function EfficientFrontier({ simulationResult, isRunning, corrStart, corrEnd, riskFreeRate = 0.0575, mcIterations = 100000 }) {
  const { cloudData, optimaData, specialData, frontierData, domainX, domainY, sharpeMin, sharpeRange, meta } = useMemo(() => {
    if (!simulationResult) return {};

    const {
      portfolios,
      scenarioOptima = [],
      robustPortfolio: robust,
      bestSharpePortfolio: best,
      minVariancePortfolio: mvp,
      consensusPortfolio: consensus,
      frontierPoints = [],
      meta: simMeta,
    } = simulationResult;

    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    let sMin = Infinity, sMax = -Infinity;

    const cloud = (portfolios ?? []).map(p => {
      const pt = toChartPoint(p, 'Robust fixed weights');
      if (pt.x < xMin) xMin = pt.x; if (pt.x > xMax) xMax = pt.x;
      if (pt.y < yMin) yMin = pt.y; if (pt.y > yMax) yMax = pt.y;
      if (pt.s < sMin) sMin = pt.s; if (pt.s > sMax) sMax = pt.s;
      return pt;
    });

    const optima = scenarioOptima.map(p => toChartPoint(p, 'Scenario optimal'));
    ({ xMin, xMax, yMin, yMax } = extendDomain(xMin, xMax, yMin, yMax, optima));

    const specials = [];
    if (robust) specials.push(toChartPoint(robust, 'Robust'));
    if (best) specials.push(toChartPoint(best, 'Oracle Sharpe'));
    if (mvp) specials.push(toChartPoint(mvp, 'Min variance'));
    if (consensus) specials.push(toChartPoint(consensus, 'Consensus'));
    ({ xMin, xMax, yMin, yMax } = extendDomain(xMin, xMax, yMin, yMax, specials));

    // Robustness frontier sweep points
    const frontierPts = frontierPoints.map(fp => ({
      x: fp.portfolioRisk * 100,
      y: fp.portfolioReturn * 100,
      s: fp.portfolioSharpe,
      lambda: fp.lambda,
      color: lambdaColor(fp.lambda),
      isActive: fp.lambda === (simMeta?.tailPenalty ?? DEFAULT_TAIL_PENALTY),
      layer: `λ=${fp.lambda.toFixed(2)}`,
    }));
    ({ xMin, xMax, yMin, yMax } = extendDomain(xMin, xMax, yMin, yMax, frontierPts));

    const xPad = (xMax - xMin) * 0.08 + 0.5;
    const yPad = (yMax - yMin) * 0.08 + 0.5;

    return {
      cloudData: cloud,
      optimaData: optima,
      frontierData: frontierPts,
      specialData: {
        robust: robust ? [toChartPoint(robust, 'Robust')] : [],
        bestSharpe: best ? [toChartPoint(best, 'Oracle Sharpe')] : [],
        minVar: mvp ? [toChartPoint(mvp, 'Min variance')] : [],
        consensus: consensus ? [toChartPoint(consensus, 'Consensus')] : [],
      },
      domainX: [+(xMin - xPad).toFixed(2), +(xMax + xPad).toFixed(2)],
      domainY: [+(yMin - yPad).toFixed(2), +(yMax + yPad).toFixed(2)],
      sharpeMin: sMin,
      sharpeRange: sMax - sMin,
      meta: simMeta,
    };
  }, [simulationResult]);

  const CloudDot = useMemo(
    () => (sharpeMin != null ? makeCloudDot(sharpeMin, sharpeRange) : null),
    [sharpeMin, sharpeRange],
  );

  const corrColor = '#00CFFD';
  const { robustPortfolio, bestSharpePortfolio, minVariancePortfolio, consensusPortfolio } = simulationResult ?? {};
  const totalScenarios = meta?.totalScenarios ?? simulationResult?.portfolios?.length ?? 0;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>EFFICIENT FRONTIER CLOUD</div>
          <div style={s.subtitle}>
            {simulationResult
              ? `${(meta?.optimaComputed ?? 0).toLocaleString()} scenario optima · ${(meta?.chartPoints ?? 0).toLocaleString()} robust chart pts`
              : 'Run simulation to populate cloud'}
          </div>
        </div>
        <div style={s.badges}>
          <span style={{ ...s.badge, borderColor: corrColor + '55', color: corrColor }}>
            ρ {corrStart?.slice(2)} → {corrEnd?.slice(2)}
          </span>
          {robustPortfolio && (
            <span style={{ ...s.badge, borderColor: '#FFD70055', color: '#FFD700' }}>
              ★ SR {sharpeRatio(robustPortfolio.portfolioReturn, robustPortfolio.portfolioRisk, riskFreeRate).toFixed(3)}
              {meta?.robustMode === 'tailAware' && ` λ=${(meta?.tailPenalty ?? DEFAULT_TAIL_PENALTY).toFixed(2)}`}
            </span>
          )}
          {bestSharpePortfolio && (
            <span style={{ ...s.badge, borderColor: '#FF2D6F88', color: '#FF2D6F' }}>
              ⚡ oracle SR {sharpeRatio(bestSharpePortfolio.portfolioReturn, bestSharpePortfolio.portfolioRisk, riskFreeRate).toFixed(3)}
            </span>
          )}
          {consensusPortfolio && (
            <span style={{ ...s.badge, borderColor: '#10B98155', color: '#10B981' }}>
              ◎ consensus SR {sharpeRatio(consensusPortfolio.portfolioReturn, consensusPortfolio.portfolioRisk, riskFreeRate).toFixed(3)}
            </span>
          )}
          {minVariancePortfolio && (
            <span style={{ ...s.badge, borderColor: '#00CFFD55', color: '#00CFFD' }}>
              ◆ σ {(minVariancePortfolio.portfolioRisk * 100).toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      <div style={{ position: 'relative', height: 440 }}>
        {isRunning && (
          <div style={s.overlay}>
            <div style={s.spinner} />
            <span style={{ color: '#475569', fontSize: 11, marginTop: 12 }}>
              Running {mcIterations.toLocaleString()} scenarios…
            </span>
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

              <Tooltip content={<FrontierTooltip riskFreeRate={riskFreeRate} />} cursor={{ stroke: '#1E3A5F', strokeWidth: 1 }} />

              <ReferenceLine
                y={riskFreeRate * 100}
                stroke="#1E3A5F55"
                strokeDasharray="6 3"
                label={{ value: `RF ${(riskFreeRate * 100).toFixed(2)}%`, fill: '#1E3A5F', fontSize: 8, position: 'right' }}
              />

              {/* Scenario-optimal cloud (purple, behind) */}
              {optimaData?.length > 0 && (
                <Scatter
                  name="Scenario Optimal"
                  data={optimaData}
                  shape={<OptimaDot />}
                  legendType="none"
                  isAnimationActive={false}
                />
              )}

              <Scatter
                name="Robust Scenarios"
                data={cloudData}
                shape={<CloudDot />}
                legendType="none"
                isAnimationActive={false}
              />

              {/* Robustness frontier overlay (λ sweep) */}
              {frontierData?.length > 0 && (
                <Scatter
                  name="Robustness frontier"
                  data={frontierData}
                  shape={<FrontierLineDot />}
                  legendType="none"
                  isAnimationActive={false}
                />
              )}

              <Scatter name="Min Variance" data={specialData.minVar} shape={<DiamondDot />} legendType="diamond" isAnimationActive={false} />
              <Scatter name="Consensus" data={specialData.consensus ?? []} shape={<ConsensusDot />} legendType="none" isAnimationActive={false} />
              <Scatter name="Robust Portfolio" data={specialData.robust} shape={<StarDot />} legendType="star" isAnimationActive={false} />
              <Scatter name="Oracle Sharpe" data={specialData.bestSharpe} shape={<BestSharpeDot />} legendType="circle" isAnimationActive={false} />
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={s.legend}>
        <span style={{ color: '#A78BFA', fontSize: 11, opacity: 0.7 }}>■</span>
        <span style={{ fontSize: 8, color: '#64748B' }}>Scenario optimal</span>
        <span style={{ color: '#3B82F6', fontSize: 11, marginLeft: 10 }}>■</span>
        <div style={s.legendBar} />
        <span style={{ color: '#00FF88', fontSize: 11 }}>■</span>
        <span style={{ fontSize: 8, color: '#334155', marginLeft: 4 }}>Robust cloud</span>
        <span style={{ color: '#FFD700', marginLeft: 12, fontSize: 10 }}>★ Robust</span>
        <span style={{ color: '#FF2D6F', marginLeft: 10, fontSize: 10 }}>⚡ Oracle</span>
        <span style={{ color: '#10B981', marginLeft: 10, fontSize: 10 }}>◎ Consensus</span>
        <span style={{ color: '#00CFFD', marginLeft: 10, fontSize: 10 }}>◆ Min Var</span>
        {simulationResult?.frontierPoints?.length > 0 && (
          <span style={{ marginLeft: 10, fontSize: 8, color: '#64748B' }}>
            ● Robustness frontier (λ sweep: green=0 → red=1)
          </span>
        )}
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
  legend: { display: 'flex', alignItems: 'center', gap: 4, padding: '8px 16px 12px', borderTop: '1px solid #0A1628', flexWrap: 'wrap' },
  legendBar: { width: 80, height: 4, borderRadius: 2, background: 'linear-gradient(to right, #3B82F6, #F59E0B, #00FF88)' },
};
