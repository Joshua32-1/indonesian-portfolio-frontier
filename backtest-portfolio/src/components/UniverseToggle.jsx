/** Sector-less ticker toggle list (mirrors the optimizer's CORRELATION-tab universe panel). */
export default function UniverseToggle({ tickers, included, newestIncluded, onToggle, onAll, onNone }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: '#7DA8C7' }}>
          UNIVERSE ({included.size}/{tickers.length})
        </span>
        <span>
          <button onClick={onAll} style={btn}>All</button>
          <button onClick={onNone} style={btn}>None</button>
        </span>
      </div>
      <div style={{ maxHeight: 520, overflowY: 'auto', paddingRight: 4 }}>
        {tickers.map(t => {
          const on = included.has(t.ticker);
          const binds = on && t.ticker === newestIncluded;
          return (
            <label key={t.ticker} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px',
              borderRadius: 6, cursor: 'pointer',
              background: on ? 'rgba(16,185,129,0.08)' : 'transparent',
              opacity: on ? 1 : 0.5,
            }}>
              <input type="checkbox" checked={on} onChange={() => onToggle(t.ticker)} style={{ accentColor: '#10B981' }} />
              <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, color: '#E2E8F0', width: 46 }}>{t.ticker}</span>
              <span style={{ fontSize: 10, color: '#5B7A95', fontFamily: 'monospace' }}>{t.listing}</span>
              {binds && (
                <span title="Newest included listing — this name sets the backtest start"
                  style={{ marginLeft: 'auto', fontSize: 9, color: '#F59E0B', fontWeight: 700 }}>◀ binds window</span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

const btn = {
  background: 'none', border: '1px solid #1E3A5F', borderRadius: 4, color: '#7DA8C7',
  fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '2px 8px', marginLeft: 4,
};
