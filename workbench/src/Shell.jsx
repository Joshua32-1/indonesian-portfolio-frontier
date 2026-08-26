/**
 * Shell.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The unified site: one top-level nav over the two existing apps, both fed by the
 * shared editable universe.
 *
 *   OPTIMIZER — portfolio-app/src/App.jsx        (Monte Carlo + BL + robust optimization)
 *   BACKTEST  — backtest-portfolio/src/App.jsx   (cost-aware walk-forward)
 *   UNIVERSE  — edit the ticker list, re-run either tool
 *
 * Both apps are imported in place and handed their data as a prop. Neither was
 * forked, and both still run standalone on :5173 / :5174 against their static files.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState } from 'react';
import OptimizerApp from '../../portfolio-app/src/App.jsx';
import BacktestApp from '../../backtest-portfolio/src/App.jsx';
import UniversePanel from './universe/UniversePanel.jsx';
import { useUniverse } from './universe/UniverseContext.jsx';

const TABS = ['OPTIMIZER', 'BACKTEST', 'UNIVERSE'];

const s = {
  root: {
    minHeight: '100vh', background: '#030A14', color: '#E2E8F0',
    fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace",
  },
  bar: {
    display: 'flex', alignItems: 'center', gap: 0, padding: '0 20px',
    borderBottom: '1px solid #0A1628', background: '#050D1A',
    position: 'sticky', top: 0, zIndex: 200,
  },
  brand: { display: 'flex', flexDirection: 'column', paddingRight: 22 },
  name: { fontSize: 12, fontWeight: 800, letterSpacing: 3 },
  sub: { fontSize: 8, color: '#334155', letterSpacing: 1.5, marginTop: 2 },
  tab: (on) => ({
    background: 'none', border: 'none',
    borderBottom: `2px solid ${on ? '#00CFFD' : 'transparent'}`,
    padding: '14px 18px', fontSize: 10, fontWeight: 800, letterSpacing: 1.5,
    cursor: 'pointer', fontFamily: 'inherit', color: on ? '#00CFFD' : '#475569',
  }),
  status: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 9, letterSpacing: 1 },
  pill: (color) => ({
    background: '#0A1628', border: `1px solid ${color}44`, color,
    borderRadius: 4, padding: '3px 8px', fontSize: 9, fontWeight: 700, letterSpacing: 1,
  }),
  centre: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    minHeight: 'calc(100vh - 46px)', gap: 14, textAlign: 'center', padding: 24,
  },
  spinner: {
    width: 30, height: 30, border: '3px solid #0F2337', borderTopColor: '#00CFFD',
    borderRadius: '50%', animation: 'spin 0.8s linear infinite',
  },
  link: {
    background: 'none', border: '1px solid #1E3A5F', borderRadius: 5, color: '#7DA8C7',
    fontSize: 10, fontWeight: 800, letterSpacing: 1, padding: '7px 14px',
    cursor: 'pointer', fontFamily: 'inherit',
  },
};

export default function Shell() {
  const [tab, setTab] = useState('OPTIMIZER');
  const { status, progress, error, snapshot, history, version, asOf, symbols, isStale, isDefault } = useUniverse();

  const ready = status === 'ready' && snapshot && history;

  return (
    <div style={s.root}>
      <nav style={s.bar}>
        <div style={s.brand}>
          <span style={s.name}>IDX WORKBENCH</span>
          <span style={s.sub}>OPTIMIZER · BACKTESTER</span>
        </div>
        {TABS.map(t => (
          <button key={t} style={s.tab(tab === t)} onClick={() => setTab(t)}>{t}</button>
        ))}
        <div style={s.status}>
          {isStale && <span style={s.pill('#F59E0B')}>UNIVERSE EDITED</span>}
          {!isDefault && !isStale && <span style={s.pill('#8B5CF6')}>CUSTOM UNIVERSE</span>}
          <span style={s.pill('#64748B')}>{symbols.length} NAMES</span>
          {asOf?.lastBar && (
            <span
              style={s.pill('#10B981')}
              title={`Newest daily close in the loaded data: ${asOf.lastBar}. Weekly bars through ${asOf.lastWeekly}. Fetched ${new Date(asOf.fetchedAt).toLocaleString()}.\nYahoo only publishes settled bars, so the newest close is normally the previous session.`}
            >
              DATA {asOf.lastBar}
            </span>
          )}
        </div>
      </nav>

      {/* Both tools mount only once data exists — neither has a meaningful empty state. */}
      {!ready ? (
        <div style={s.centre}>
          {status === 'error' ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#F87171', letterSpacing: 1 }}>
                COULD NOT LOAD MARKET DATA
              </div>
              <div style={{ fontSize: 11, color: '#64748B', maxWidth: 460, lineHeight: 1.7 }}>{error}</div>
              <button style={s.link} onClick={() => setTab('UNIVERSE')}>OPEN UNIVERSE TAB</button>
            </>
          ) : (
            <>
              <div style={s.spinner} />
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2, color: '#7DA8C7' }}>
                FETCHING LIVE MARKET DATA
              </div>
              <div style={{ fontSize: 10, color: '#475569' }}>
                {progress ? `${progress.label} — ${progress.done}/${progress.total}` : 'Contacting Yahoo Finance…'}
              </div>
              <div style={{ fontSize: 9, color: '#334155', maxWidth: 420, lineHeight: 1.7 }}>
                {symbols.length} tickers, ~15 years of weekly and daily bars each. Subsequent
                loads are served from the edge cache.
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          {/* Kept mounted, not unmounted, so an expensive Monte Carlo or walk-forward
              result survives a tab switch. */}
          <div style={{ display: tab === 'OPTIMIZER' ? 'block' : 'none' }}>
            <OptimizerApp snapshot={snapshot} chrome={false} />
          </div>
          <div style={{ display: tab === 'BACKTEST' ? 'block' : 'none' }}>
            <BacktestApp history={history} dataVersion={version} isDefaultUniverse={isDefault} />
          </div>
          <div style={{ display: tab === 'UNIVERSE' ? 'block' : 'none', padding: 20 }}>
            <UniversePanel />
          </div>
        </>
      )}
    </div>
  );
}
