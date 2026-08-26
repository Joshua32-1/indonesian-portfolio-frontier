/**
 * UniverseContext.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The single owner of "which tickers are we looking at, and what data do we have
 * for them" — shared by the OPTIMIZER and BACKTEST tabs so both always run over the
 * same universe.
 *
 * Edits are SESSION-LOCAL: persisted to localStorage, never written back to the repo.
 * portfolio-app/data/universe.js stays the canonical list that the weekly-rebalance
 * cron and the 300-stream forward test run on.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { UNIVERSE_JK, toBare, toJK } from '../../../portfolio-app/data/universe.js';
import {
  clearCache,
  dataAsOf,
  dataVersion,
  loadUniverse,
  toBacktestHistory,
  toOptimizerSnapshot,
} from './marketDataClient.js';

/** Bump when the stored shape changes so old entries are discarded, not misread. */
const STORAGE_KEY = 'idx-workbench.universe.v1';

/** The 25 names in portfolio-app/data/universe.js — imported, never duplicated. */
export const DEFAULT_SYMBOLS = [...UNIVERSE_JK];

const UniverseCtx = createContext(null);

export function useUniverse() {
  const ctx = useContext(UniverseCtx);
  if (!ctx) throw new Error('useUniverse must be used inside <UniverseProvider>');
  return ctx;
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SYMBOLS;
    const parsed = JSON.parse(raw);
    // Anything malformed or empty falls back to the default rather than throwing.
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_SYMBOLS;
    const clean = [...new Set(parsed.filter(s => typeof s === 'string' && s).map(toJK))];
    return clean.length ? clean : DEFAULT_SYMBOLS;
  } catch {
    return DEFAULT_SYMBOLS;
  }
}

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

export function UniverseProvider({ children }) {
  const [symbols, setSymbols] = useState(readStored);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [progress, setProgress] = useState(null); // { done, total, label }
  const [error, setError] = useState(null);
  const [failures, setFailures] = useState([]);
  const [raw, setRaw] = useState(null); // last successful loadUniverse() result

  const abortRef = useRef(null);
  const runRef = useRef(0); // monotonic id so a superseded load can't publish its result

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols));
    } catch {
      // Private-mode / quota failures are not worth breaking the app over.
    }
  }, [symbols]);

  const load = useCallback(async (targetSymbols, { force = false } = {}) => {
    const list = targetSymbols ?? symbols;
    if (list.length === 0) {
      setRaw(null);
      setStatus('idle');
      setError('Add at least one ticker.');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const runId = ++runRef.current;

    setStatus('loading');
    setError(null);
    setFailures([]);

    try {
      const result = await loadUniverse(list, {
        force,
        signal: controller.signal,
        onProgress: (p) => { if (runId === runRef.current) setProgress(p); },
      });
      if (runId !== runRef.current) return; // superseded by a newer load

      if (result.tickers.length === 0) {
        setStatus('error');
        setError('No ticker could be loaded. Check the symbols and try again.');
        setFailures(result.failures);
        return;
      }
      setRaw(result);
      setFailures(result.failures);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || runId !== runRef.current) return;
      setStatus('error');
      setError(err?.message ?? String(err));
    } finally {
      if (runId === runRef.current) setProgress(null);
    }
  }, [symbols]);

  // Initial load, once.
  useEffect(() => {
    load(readStored());
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addSymbol = useCallback((symbol) => {
    const jk = toJK(String(symbol).toUpperCase());
    setSymbols(prev => (prev.includes(jk) ? prev : [...prev, jk]));
  }, []);

  const removeSymbol = useCallback((symbol) => {
    const jk = toJK(String(symbol).toUpperCase());
    setSymbols(prev => prev.filter(s => s !== jk));
  }, []);

  const resetToDefault = useCallback(() => setSymbols([...DEFAULT_SYMBOLS]), []);

  /** Discards memoised payloads and re-hits the API for the whole universe. */
  const refetch = useCallback(() => {
    clearCache();
    return load(symbols, { force: true });
  }, [load, symbols]);

  // Derived contracts. Memoised on `raw` so switching tabs never re-adapts 3 MB.
  const snapshot = useMemo(() => (raw ? toOptimizerSnapshot(raw) : null), [raw]);
  const history = useMemo(() => (raw ? toBacktestHistory(raw) : null), [raw]);
  const version = useMemo(() => (raw ? dataVersion(raw) : null), [raw]);
  const asOf = useMemo(() => (raw ? dataAsOf(raw) : null), [raw]);

  // Symbols chosen but not yet run — i.e. edits awaiting a FETCH & RUN.
  // A symbol that FAILED to load counts as accounted-for: it is reported in `failures`,
  // and treating it as an unrun edit would pin the universe to "edited" forever with no
  // way out but deleting it.
  const loadedSymbols = useMemo(() => (raw?.tickers ?? []).map(t => toJK(t.ticker)), [raw]);
  const accountedFor = useMemo(
    () => [...new Set([...loadedSymbols, ...failures.map(f => toJK(f.symbol))])],
    [loadedSymbols, failures],
  );
  const isStale = useMemo(
    () => status === 'ready' && !sameSet(symbols, accountedFor),
    [status, symbols, accountedFor],
  );
  const isDefault = useMemo(() => sameSet(symbols, DEFAULT_SYMBOLS), [symbols]);

  const value = useMemo(() => ({
    symbols, tickers: symbols.map(toBare),
    status, progress, error, failures,
    snapshot, history, version, asOf,
    isStale, isDefault,
    riskFreeRate: raw?.rf?.riskFreeRate ?? null,
    rfSource: raw?.rf?.source ?? null,
    addSymbol, removeSymbol, resetToDefault,
    run: () => load(symbols), refetch,
  }), [symbols, status, progress, error, failures, snapshot, history, version, asOf,
      isStale, isDefault, raw, addSymbol, removeSymbol, resetToDefault, load, refetch]);

  return <UniverseCtx.Provider value={value}>{children}</UniverseCtx.Provider>;
}
