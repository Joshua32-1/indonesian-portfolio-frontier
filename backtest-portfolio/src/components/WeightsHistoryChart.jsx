import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

// Distinct, readable cycle for stacked weight bands.
const PALETTE = [
  '#10B981', '#F59E0B', '#7DA8C7', '#A78BFA', '#F472B6', '#34D399',
  '#FBBF24', '#60A5FA', '#FB7185', '#2DD4BF', '#C084FC', '#FACC15',
];
const OTHER_COLOR = '#33415580';
const TOP = 12; // individual bands; the rest aggregate into "Other"

/**
 * Stacked-area history of the strategy's weights across every rebalance.
 * @param {Array}  weightRows  [{ date, [ticker]: weight% }]
 * @param {string[]} order     tickers sorted by avg weight (largest first)
 */
export default function WeightsHistoryChart({ weightRows, order }) {
  if (!weightRows?.length) {
    return <div style={{ color: '#5B7A95', padding: 30, textAlign: 'center' }}>No rebalances to show.</div>;
  }
  const top = order.slice(0, TOP);
  const data = weightRows.map(row => {
    const o = { date: row.date };
    let used = 0;
    for (const t of top) { const v = row[t] ?? 0; o[t] = v; used += v; }
    o.Other = Math.max(0, +(100 - used).toFixed(2));
    return o;
  });
  const keys = [...top, 'Other'];
  const colorFor = (k, i) => (k === 'Other' ? OTHER_COLOR : PALETTE[i % PALETTE.length]);
  const step = Math.max(1, Math.floor(data.length / 8));
  const ticks = data.filter((_, i) => i % step === 0).map(d => d.date);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="#16304D" strokeDasharray="3 3" />
        <XAxis dataKey="date" ticks={ticks} tick={{ fontSize: 10, fill: '#5B7A95' }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#5B7A95' }}
          label={{ value: 'Weight %', angle: -90, position: 'insideLeft', fill: '#5B7A95', fontSize: 10 }} />
        <Tooltip
          contentStyle={{ background: '#0E1F35', border: '1px solid #1E3A5F', borderRadius: 6, fontSize: 11 }}
          labelStyle={{ color: '#7DA8C7' }} itemSorter={it => -it.value} />
        <Legend wrapperStyle={{ fontSize: 10 }} />
        {keys.map((k, i) => (
          <Area key={k} dataKey={k} stackId="1" stroke={colorFor(k, i)} fill={colorFor(k, i)}
            fillOpacity={0.82} strokeWidth={0.5} isAnimationActive={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
