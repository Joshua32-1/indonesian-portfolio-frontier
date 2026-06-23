import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';

const COLORS = { MinVar: '#10B981', EqualWeight: '#F59E0B', IHSG: '#7DA8C7' };

export default function EquityCurveChart({ chart }) {
  if (!chart?.length) {
    return <div style={{ color: '#5B7A95', padding: 40, textAlign: 'center' }}>No data — adjust the universe.</div>;
  }
  // Thin x-axis ticks for readability.
  const step = Math.max(1, Math.floor(chart.length / 8));
  const ticks = chart.filter((_, i) => i % step === 0).map(d => d.date);

  return (
    <ResponsiveContainer width="100%" height={360}>
      <LineChart data={chart} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="#16304D" strokeDasharray="3 3" />
        <XAxis dataKey="date" ticks={ticks} tick={{ fontSize: 10, fill: '#5B7A95' }} />
        <YAxis tick={{ fontSize: 10, fill: '#5B7A95' }} domain={['auto', 'auto']}
          label={{ value: 'Indexed = 100', angle: -90, position: 'insideLeft', fill: '#5B7A95', fontSize: 10 }} />
        <ReferenceLine y={100} stroke="#2A4A6B" strokeDasharray="2 2" />
        <Tooltip
          contentStyle={{ background: '#0E1F35', border: '1px solid #1E3A5F', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#7DA8C7' }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {['MinVar', 'EqualWeight', 'IHSG'].map(key => (
          <Line key={key} type="monotone" dataKey={key} stroke={COLORS[key]}
            strokeWidth={key === 'MinVar' ? 2.4 : 1.6}
            strokeDasharray={key === 'IHSG' ? '5 4' : undefined}
            dot={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
