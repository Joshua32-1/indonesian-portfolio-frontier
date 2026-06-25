import { useState } from 'react';
import EquityCurveChart from './EquityCurveChart.jsx';
import MetricsTable from './MetricsTable.jsx';

// Baselines + Max-Sharpe fixed colors; tail-λ variants get a purple gradient
// (deeper = more tail-averse) assigned by order.
const BASE_COLORS = { MaxSharpe: '#F472B6', MinVar: '#10B981', EqualWeight: '#F59E0B', IHSG: '#7DA8C7' };
const TAIL_COLORS = ['#A78BFA', '#8B5CF6', '#6D28D9', '#4C1D95'];

const pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = v => (v == null ? '—' : v.toFixed(2));

function colorMap(variants) {
  const m = { ...BASE_COLORS };
  let ti = 0;
  for (const v of variants) {
    if (v.mode === 'tailAware') m[v.key] = TAIL_COLORS[ti++ % TAIL_COLORS.length];
    else if (!m[v.key]) m[v.key] = '#F472B6';
  }
  return m;
}

// Series descriptors (variants + baselines). feeMode only changes which curve array
// is read, not the descriptors.
function buildSeries(variants, colors) {
  return [
    ...variants.map(v => ({ key: v.key, label: v.label, color: colors[v.key], width: 2.0 })),
    { key: 'MinVar', label: 'Min-Var', color: colors.MinVar, width: 1.4 },
    { key: 'EqualWeight', label: 'Equal-Wt', color: colors.EqualWeight, width: 1.4 },
    { key: 'IHSG', label: 'IHSG', color: colors.IHSG, width: 1.4, dash: '5 4' },
  ];
}

// Pivot stored curves into Recharts rows for a given fee mode.
function buildChart(freqBlock, feeMode, seriesKeys) {
  const { dates, curves } = freqBlock;
  return dates.map((d, i) => {
    const row = { date: d };
    for (const k of seriesKeys) {
      const c = curves[k];
      if (!c) continue;
      const arr = k === 'IHSG' ? c.eq : feeMode === 'gross' ? c.grossEq : c.netEq;
      row[k] = arr?.[i];
    }
    return row;
  });
}

export default function StrategyBacktest({ results }) {
  const [frequency, setFrequency] = useState(null);
  const [feeMode, setFeeMode] = useState('net');
  const [sweepFreq, setSweepFreq] = useState(null);
  const [hidden, setHidden] = useState(() => new Set()); // hidden series keys (empty = all shown)

  if (results === undefined) return null;
  if (results === null) {
    return (
      <div style={{ fontSize: 12, color: '#5B7A95' }}>
        No precomputed strategy backtest found. Run <code style={code}>npm run backtest</code> to generate
        <code style={code}>public/backtest-results.json</code> (it optimizes Max-Sharpe + tail-λ variants per
        rebalance × frequency, so it's computed offline rather than on every universe toggle).
      </div>
    );
  }
  if (!results.ok) {
    return <div style={{ fontSize: 12, color: '#F59E0B' }}>⚠️ {(results.warnings || []).join('; ')}</div>;
  }

  const { params, byFrequency, headline } = results;
  const freqKeys = Object.keys(byFrequency);
  const freq = frequency ?? headline?.frequency ?? freqKeys[0];
  const kFreq = sweepFreq ?? headline?.frequency ?? freqKeys[0];
  const variants = params.variants;
  const colors = colorMap(variants);
  const series = buildSeries(variants, colors);
  const seriesKeys = series.map(s => s.key);

  const freqBlock = byFrequency[freq];
  // Per-series visibility (main chart only): hidden keys are filtered out.
  const shownSeries = series.filter(s => !hidden.has(s.key));
  const chart = buildChart(freqBlock, feeMode, shownSeries.map(s => s.key));
  const toggleSeries = key => setHidden(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const cols = [
    ...variants.map(v => ({ key: v.key, label: v.label, color: colors[v.key] })),
    { key: 'MinVar', label: 'Min-Var', color: colors.MinVar },
    { key: 'EqualWeight', label: 'Equal-Wt', color: colors.EqualWeight },
    { key: 'IHSG', label: 'IHSG', color: colors.IHSG },
  ];

  return (
    <div>
      <div style={{ fontSize: 11, color: '#5B7A95', marginBottom: 10, lineHeight: 1.6 }}>
        BL-equilibrium prior → Max-Sharpe and Tail-Aware (λ = {params.lambdas.join(', ')}) objectives on Ledoit-Wolf Σ,
        long-only, fixed turnover penalty <b>κ={params.kappa}</b>.
        <b style={{ color: '#9FB8CC' }}> Machinery only — no analyst views</b> (those drive the live forward-test).
        Costs: <b>{params.costModel}</b>; cap weights: {params.capMode}.
        Window {results.window.start} → {results.window.end}, {results.window.nTickers} names.
      </div>

      {/* selectors */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
        <Toggle label="Rebalance" value={freq} setValue={f => setFrequency(f)}
          options={freqKeys.map(k => ({ value: k, label: byFrequency[k].label }))} />
        <Toggle label="Fees" value={feeMode} setValue={setFeeMode}
          options={[{ value: 'net', label: 'Net of costs' }, { value: 'gross', label: 'Gross (no fees)' }]} />
      </div>

      {/* per-series show/hide chips (main chart only) */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {series.map(s => {
          const on = !hidden.has(s.key);
          return (
            <button key={s.key} onClick={() => toggleSeries(s.key)} title={on ? 'Click to hide' : 'Click to show'} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
              border: `1px solid ${on ? s.color : '#1E3A5F'}`, borderRadius: 12, padding: '2px 9px',
              background: on ? `${s.color}22` : 'transparent', color: on ? '#E2E8F0' : '#46617B',
              fontSize: 11, fontWeight: 600,
            }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: on ? s.color : '#324b66' }} />
              {s.label}
            </button>
          );
        })}
      </div>

      <EquityCurveChart chart={chart} series={shownSeries} />
      <MetricsTable metrics={freqBlock.metrics} cols={cols} />

      {/* Small-multiples: frequency (rows) × fees (cols), variants overlaid */}
      <div style={subTitle}>ALL VIEWS — frequency × fees (Max-Sharpe + tail-λ + baselines)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {freqKeys.flatMap(fk => (['net', 'gross'].map(fm => (
          <div key={`${fk}-${fm}`} style={miniPanel}>
            <div style={miniTitle}>{byFrequency[fk].label} · {fm === 'net' ? 'net of costs' : 'gross'}</div>
            <EquityCurveChart chart={buildChart(byFrequency[fk], fm, seriesKeys)} series={series} height={180} showLegend={false} />
          </div>
        ))))}
      </div>
      <div style={{ fontSize: 10, color: '#5B7A95', marginTop: 6 }}>
        {series.map(s => (
          <span key={s.key} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-block', width: 10, height: 2, background: s.color, verticalAlign: 'middle', marginRight: 4 }} />
            {s.label}
          </span>
        ))}
      </div>

      {/* κ sweep with its own frequency selector */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 6px' }}>
        <span style={{ ...subTitle, margin: 0 }}>TURNOVER-PENALTY (κ) SWEEP — at λ={params.tailPenalty}, net of costs</span>
        <Toggle label="" value={kFreq} setValue={setSweepFreq}
          options={freqKeys.map(k => ({ value: k, label: byFrequency[k].label }))} small />
      </div>
      <SweepTable sweep={byFrequency[kFreq].kappaSweep} fixedKappa={params.kappa} />

      {/* frequency comparison: best variant per frequency */}
      <div style={subTitle}>BEST VARIANT PER FREQUENCY — net of costs</div>
      <FreqTable byFrequency={byFrequency} variants={variants} />

      <div style={subTitle}>LIMITATIONS</div>
      <ul style={{ fontSize: 11, color: '#7DA8C7', margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
        {results.limitations.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  );
}

function Toggle({ label, value, setValue, options, small }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {label && <span style={{ fontSize: 10, letterSpacing: 1, color: '#5B7A95', fontWeight: 700 }}>{label}</span>}
      <span style={{ display: 'inline-flex', border: '1px solid #1E3A5F', borderRadius: 6, overflow: 'hidden' }}>
        {options.map(o => (
          <button key={o.value} onClick={() => setValue(o.value)} style={{
            border: 'none', cursor: 'pointer', padding: small ? '2px 8px' : '4px 12px',
            fontSize: small ? 10 : 11, fontWeight: 700,
            background: value === o.value ? '#8B5CF6' : 'transparent',
            color: value === o.value ? '#0E0820' : '#7DA8C7',
          }}>{o.label}</button>
        ))}
      </span>
    </div>
  );
}

function SweepTable({ sweep, fixedKappa }) {
  if (!sweep?.length) return null;
  const cols = [
    { k: 'kappa', label: 'κ', fmt: v => v.toFixed(2) },
    { k: 'sharpe', label: 'Sharpe net', fmt: num },
    { k: 'grossSharpe', label: 'Sharpe gross', fmt: num },
    { k: 'infoRatio', label: 'IR', fmt: num },
    { k: 'tStat', label: 't-stat', fmt: num },
    { k: 'maxDrawdown', label: 'Max DD', fmt: pct },
    { k: 'annualTurnover', label: 'Turn/yr', fmt: v => `${v.toFixed(1)}×` },
    { k: 'annualCostDrag', label: 'Drag/yr', fmt: pct },
  ];
  return (
    <table style={tbl}>
      <thead><tr>{cols.map(c => <th key={c.k} style={th}>{c.label}</th>)}</tr></thead>
      <tbody>
        {sweep.map(row => {
          const isFixed = Math.abs(row.kappa - fixedKappa) < 1e-9;
          return (
            <tr key={row.kappa} style={isFixed ? { background: '#15233D' } : undefined}>
              {cols.map(c => (
                <td key={c.k} style={{ ...td, color: isFixed && c.k === 'kappa' ? '#8B5CF6' : '#E2E8F0', fontWeight: isFixed ? 700 : 400 }}>
                  {c.fmt(row[c.k])}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FreqTable({ byFrequency, variants }) {
  const best = m => variants.reduce((b, v) => (m[v.key] && (!b || m[v.key].sharpe > m[b.key].sharpe) ? { key: v.key, ...m[v.key], label: v.label } : b), null);
  return (
    <table style={tbl}>
      <thead><tr>
        {['Frequency', 'Best variant', 'Sharpe net', 'Sharpe gross', 'IR', 't-stat', 'Turn/yr', 'Drag/yr', 'Rebals'].map(h => <th key={h} style={th}>{h}</th>)}
      </tr></thead>
      <tbody>
        {Object.entries(byFrequency).map(([key, b]) => {
          const bv = best(b.metrics);
          return (
            <tr key={key}>
              <td style={{ ...td, textAlign: 'left', color: '#7DA8C7' }}>{b.label}</td>
              <td style={{ ...td, textAlign: 'left' }}>{bv?.label ?? '—'}</td>
              <td style={td}>{num(bv?.sharpe)}</td>
              <td style={td}>{num(bv?.grossSharpe)}</td>
              <td style={td}>{num(bv?.infoRatio)}</td>
              <td style={td}>{num(bv?.tStat)}</td>
              <td style={td}>{bv ? `${bv.annualTurnover.toFixed(1)}×` : '—'}</td>
              <td style={td}>{pct(bv?.annualCostDrag)}</td>
              <td style={td}>{b.nRebalances}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const subTitle = { fontSize: 11, fontWeight: 700, letterSpacing: 1, color: '#7DA8C7', margin: '18px 0 6px' };
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
const th = { padding: '6px 8px', borderBottom: '1px solid #1E3A5F', fontSize: 11, fontWeight: 700, textAlign: 'right' };
const td = { padding: '5px 8px', borderBottom: '1px solid #102438', textAlign: 'right', fontFamily: 'monospace' };
const code = { background: '#0A1628', border: '1px solid #1E3A5F', borderRadius: 4, padding: '1px 5px', margin: '0 3px', fontSize: 11 };
const miniPanel = { background: '#0A1A2E', border: '1px solid #122845', borderRadius: 8, padding: '8px 8px 4px' };
const miniTitle = { fontSize: 10, fontWeight: 700, color: '#9FB8CC', marginBottom: 2 };
