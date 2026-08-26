/**
 * UniversePanel.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The UNIVERSE tab: edit the ticker list, then re-run either tool against it.
 * Styling follows the optimizer's dark terminal palette (portfolio-app/src/App.jsx).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useState } from 'react';
import { useUniverse } from './UniverseContext.jsx';
import { resolveSymbol } from './marketDataClient.js';
import { DEFAULT_SYMBOLS } from './UniverseContext.jsx';
import { toBare } from '../../../portfolio-app/data/universe.js';

const s = {
  wrap: { maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 },
  panel: { background: '#07111E', border: '1px solid #0F2337', borderRadius: 8, padding: '16px 18px' },
  h: { fontSize: 11, fontWeight: 800, letterSpacing: 2, color: '#7DA8C7', marginBottom: 10 },
  note: { fontSize: 10, color: '#64748B', lineHeight: 1.6 },
  input: {
    flex: 1, background: '#050D1A', border: '1px solid #1E3A5F', borderRadius: 5,
    padding: '8px 10px', fontSize: 12, fontWeight: 700, color: '#E2E8F0',
    fontFamily: 'inherit', outline: 'none', letterSpacing: 1, textTransform: 'uppercase',
  },
  btn: {
    padding: '8px 14px', background: '#0F2337', border: '1px solid #1E3A5F', borderRadius: 5,
    color: '#7DA8C7', fontSize: 10, fontWeight: 800, letterSpacing: 1,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  primary: {
    padding: '9px 20px', background: 'linear-gradient(135deg,#0F2337,#1E3A5F)',
    border: '1px solid #00CFFD44', borderRadius: 5, color: '#00CFFD',
    fontSize: 11, fontWeight: 800, letterSpacing: 1.5, cursor: 'pointer', fontFamily: 'inherit',
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 6 },
  chip: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
    background: '#050D1A', border: '1px solid #0F2337', borderRadius: 6,
  },
  x: {
    marginLeft: 'auto', background: 'none', border: 'none', color: '#475569',
    fontSize: 14, fontWeight: 800, cursor: 'pointer', lineHeight: 1, padding: '0 2px',
    fontFamily: 'inherit',
  },
  bar: { height: 4, background: '#0F2337', borderRadius: 2, overflow: 'hidden', marginTop: 8 },
  fill: { height: '100%', background: '#00CFFD', transition: 'width 0.2s' },
  err: { fontSize: 10, color: '#F87171', marginTop: 8, lineHeight: 1.6 },
  ok: { fontSize: 10, color: '#10B981', marginTop: 8 },
};

export default function UniversePanel() {
  const {
    symbols, status, progress, error, failures,
    isStale, isDefault, riskFreeRate, rfSource, asOf,
    addSymbol, removeSymbol, resetToDefault, run, refetch,
  } = useUniverse();

  const [draft, setDraft] = useState('');
  const [checking, setChecking] = useState(false);
  const [addError, setAddError] = useState(null);
  const [addOk, setAddOk] = useState(null);

  const handleAdd = useCallback(async (e) => {
    e.preventDefault();
    const raw = draft.trim();
    if (!raw) return;
    setAddError(null);
    setAddOk(null);

    if (symbols.some(sym => toBare(sym) === raw.toUpperCase().replace('.JK', ''))) {
      setAddError(`${raw.toUpperCase()} is already in the universe.`);
      return;
    }

    setChecking(true);
    try {
      // Validate before committing to a full ~130 KB /api/ticker fetch.
      const r = await resolveSymbol(raw);
      addSymbol(r.symbol);
      setAddOk(`Added ${r.ticker} — ${r.name} (${r.sector}).`);
      setDraft('');
    } catch (err) {
      setAddError(err?.message ?? 'Could not resolve that ticker.');
    } finally {
      setChecking(false);
    }
  }, [draft, symbols, addSymbol]);

  const loading = status === 'loading';
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div style={s.wrap}>
      <div style={s.panel}>
        <div style={s.h}>UNIVERSE ({symbols.length})</div>
        <div style={s.note}>
          Edits are <strong style={{ color: '#7DA8C7' }}>local to this browser</strong> and drive both the
          OPTIMIZER and BACKTEST tabs. They do not change{' '}
          <code style={{ color: '#94A3B8' }}>portfolio-app/data/universe.js</code>, the weekly
          rebalance, or the forward-test matrix.
        </div>
      </div>

      {asOf?.lastBar && (
        <div style={s.panel}>
          <div style={s.h}>DATA FRESHNESS</div>
          <div style={s.note}>
            Newest daily close <strong style={{ color: '#10B981' }}>{asOf.lastBar}</strong>
            {' · '}weekly bars through <strong style={{ color: '#10B981' }}>{asOf.lastWeekly}</strong>
            {' · '}fetched {new Date(asOf.fetchedAt).toLocaleString()}.
            <br />
            Yahoo publishes only <em>settled</em> bars, so the newest close is normally the
            previous IDX session — not today's. Responses are edge-cached for up to an hour
            on the deployed site; <strong style={{ color: '#7DA8C7' }}>FORCE REFRESH ALL</strong> bypasses
            the local memo and re-requests every name.
          </div>
        </div>
      )}

      <div style={s.panel}>
        <div style={s.h}>ADD TICKER</div>
        <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8 }}>
          <input
            style={s.input}
            value={draft}
            onChange={e => { setDraft(e.target.value); setAddError(null); setAddOk(null); }}
            placeholder="e.g. VKTR — the .JK suffix is added for you"
            disabled={checking}
            spellCheck={false}
          />
          <button type="submit" style={{ ...s.btn, opacity: checking || !draft.trim() ? 0.5 : 1 }}
                  disabled={checking || !draft.trim()}>
            {checking ? 'CHECKING…' : 'ADD'}
          </button>
        </form>
        {addError && <div style={s.err}>{addError}</div>}
        {addOk && <div style={s.ok}>{addOk}</div>}
      </div>

      <div style={s.panel}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ ...s.h, marginBottom: 0 }}>TICKERS</div>
          <button
            onClick={resetToDefault}
            style={{ ...s.btn, marginLeft: 'auto', opacity: isDefault ? 0.4 : 1 }}
            disabled={isDefault}
            title={`Restore the ${DEFAULT_SYMBOLS.length} names in universe.js`}
          >
            RESET TO DEFAULT
          </button>
        </div>
        <div style={s.grid}>
          {symbols.map(sym => (
            <div key={sym} style={s.chip}>
              <span style={{ fontSize: 12, fontWeight: 800, color: '#E2E8F0' }}>{toBare(sym)}</span>
              <button
                style={s.x}
                onClick={() => removeSymbol(sym)}
                title={`Remove ${toBare(sym)}`}
                aria-label={`Remove ${toBare(sym)}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {symbols.length === 0 && (
          <div style={s.err}>Universe is empty — add at least one ticker.</div>
        )}
      </div>

      <div style={s.panel}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            style={{ ...s.primary, opacity: loading || symbols.length === 0 ? 0.5 : 1 }}
            onClick={run}
            disabled={loading || symbols.length === 0}
          >
            {loading ? 'FETCHING…' : isStale ? 'FETCH & RUN' : 'RELOAD UNIVERSE'}
          </button>
          <button style={{ ...s.btn, opacity: loading ? 0.5 : 1 }} onClick={refetch} disabled={loading}
                  title="Discard cached payloads and re-hit Yahoo for every name">
            FORCE REFRESH ALL
          </button>
          {riskFreeRate != null && (
            <span style={{ fontSize: 10, color: '#64748B', letterSpacing: 1 }}>
              r<sub>f</sub> {(riskFreeRate * 100).toFixed(2)}%
              {rfSource === 'fallback' && (
                <span style={{ color: '#F59E0B' }}> (fallback — BI scrape failed)</span>
              )}
            </span>
          )}
        </div>

        {loading && (
          <>
            <div style={{ fontSize: 10, color: '#64748B', marginTop: 10 }}>
              {progress?.label ?? 'Starting…'} {progress ? `— ${progress.done}/${progress.total}` : ''}
            </div>
            <div style={s.bar}><div style={{ ...s.fill, width: `${pct}%` }} /></div>
          </>
        )}

        {isStale && !loading && (
          <div style={{ fontSize: 10, color: '#F59E0B', marginTop: 10 }}>
            Universe edited — press FETCH &amp; RUN to load the new list. Only added names are fetched.
          </div>
        )}

        {error && <div style={s.err}>{error}</div>}

        {failures.length > 0 && (
          <div style={s.err}>
            Could not load {failures.length} name{failures.length > 1 ? 's' : ''} — excluded from this run:
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {failures.map(f => <li key={f.symbol}><strong>{f.symbol}</strong> — {f.message}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
