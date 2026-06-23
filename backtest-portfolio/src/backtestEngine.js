/**
 * backtestEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure-JS covariance-only walk-forward backtest. No React / DOM / I/O.
 *
 * For each weekly rebalance date t (using ONLY data ≤ t — no look-ahead):
 *   ρ  = weekly Pearson over the trailing 1 year      (computeCorrelationFromDateRange)
 *   σ  = theta-decay daily vol, halfLife 63, 252d      (resolveDailyVol/computeThetaDecayedVol)
 *   Σ  = ρ·σ·σ with Ledoit-Wolf shrinkage              (computeCovarianceMatrix)
 *   w  = min-variance, long-only, sum-to-1, no caps    (findMinVariancePortfolio, deterministic)
 * then hold one week and book the realized return. Equal-weight and IHSG are tracked
 * alongside. Returns are GROSS (no transaction costs).
 *
 * Window: backtestStart = (newest listing among included tickers) + 1 calendar year;
 * dropping the newest name(s) pushes the start earlier → a longer backtest.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  computeCorrelationFromDateRange,
  computeCovarianceMatrix,
  alignPriceSeries,
  canonicalWeeklyKey,
  DEFAULT_VOL_HALF_LIFE,
} from '../../portfolio-app/src/math/matrixEngine.js';
import { findMinVariancePortfolio } from '../../portfolio-app/src/math/monteCarlo.js';

const SQRT_52 = Math.sqrt(52);
const CORR_WINDOW_DAYS = 365; // trailing 1-year weekly correlation window

// ── small stats helpers ───────────────────────────────────────────────────────

function mean(xs) {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

/** Sample standard deviation (n−1). */
function stdev(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1);
  return Math.sqrt(Math.max(0, v));
}

function covariance(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - mx) * (ys[i] - my);
  return s / (n - 1);
}

function pearson(xs, ys) {
  const sx = stdev(xs), sy = stdev(ys);
  if (sx === 0 || sy === 0) return 0;
  return covariance(xs, ys) / (sx * sy);
}

function addCalendarDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Largest index whose date ≤ target (arrays sorted ascending). −1 if none. */
function idxAtOrBefore(dates, target) {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** Max drawdown (positive fraction) of an equity curve. */
function maxDrawdown(equity) {
  let peak = -Infinity, mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd;
}

// ── per-asset precompute ──────────────────────────────────────────────────────

/** Daily decimal log-returns with the date of each return's *later* day. */
function dailyLogReturns(daily) {
  const dates = [], vals = [];
  const d = daily?.dates ?? [], p = daily?.adjClose ?? [];
  for (let i = 1; i < p.length; i++) {
    if (p[i] > 0 && p[i - 1] > 0) {
      dates.push(d[i]);
      vals.push(Math.log(p[i] / p[i - 1]));
    }
  }
  return { dates, vals };
}

// ── metrics ───────────────────────────────────────────────────────────────────

function seriesMetrics(weeklyRets, equityFinal, rf, benchRets) {
  const nPeriods = weeklyRets.length;
  const years = nPeriods / 52;
  const annReturn = years > 0 ? Math.pow(equityFinal / 100, 1 / years) - 1 : 0;
  const annVol = stdev(weeklyRets) * SQRT_52;
  const sharpe = annVol > 0 ? (annReturn - rf) / annVol : 0;
  const mdd = maxDrawdown(cumEquity(weeklyRets));

  const out = { annReturn, annVol, sharpe, maxDrawdown: mdd };
  if (benchRets) {
    const active = weeklyRets.map((r, i) => r - benchRets[i]);
    out.trackingError = stdev(active) * SQRT_52;
    const varB = covariance(benchRets, benchRets);
    out.beta = varB > 0 ? covariance(weeklyRets, benchRets) / varB : 0;
    out.correlation = pearson(weeklyRets, benchRets);
  }
  return out;
}

function cumEquity(weeklyRets) {
  const eq = [100];
  for (const r of weeklyRets) eq.push(eq[eq.length - 1] * (1 + r));
  return eq;
}

// ── attribution ───────────────────────────────────────────────────────────────

/**
 * Per-stock return + risk attribution over the realized weekly path.
 *
 *   Return contribution (Carino-linked, so Σ_k contrib_k = compounded total R):
 *     R = Π(1+r_p) − 1,  K = ln(1+R)/R,  k_t = ln(1+r_p,t)/r_p,t
 *     contrib_k = Σ_t (k_t/K) · c_k(t)
 *   Risk contribution (ex-post realized, Σ_k RC_k = 1 since Σ_k c_k = r_p):
 *     RC_k = Cov(c_k, r_p) / Var(r_p)
 *
 * @param {Array}      included    [{ ticker }]
 * @param {Array}      weightRows  [{ date, [ticker]: weight% }] per holding period
 * @param {number[][]} cByAsset    c_k(t) = w_k(t)·r_k(t), [asset][period]
 * @param {number[]}   portRets    realized portfolio weekly returns
 */
function buildAttribution(included, weightRows, cByAsset, portRets) {
  const T = portRets.length;
  let R = 1;
  for (const r of portRets) R *= 1 + r;
  R -= 1;
  const K = Math.abs(R) < 1e-9 ? 1 : Math.log(1 + R) / R;
  const kt = portRets.map(r => (Math.abs(r) < 1e-9 ? 1 : Math.log(1 + r) / r));
  const varP = covariance(portRets, portRets);

  const rows = included.map((a, k) => {
    const c = cByAsset[k];
    let contrib = 0;
    for (let t = 0; t < T; t++) contrib += (kt[t] / K) * c[t];
    const riskContrib = varP > 0 ? covariance(c, portRets) / varP : 0;
    const avgWeight = mean(weightRows.map(row => (row[a.ticker] ?? 0) / 100));
    return {
      ticker: a.ticker,
      avgWeight,
      returnContrib: contrib,
      returnShare: Math.abs(R) < 1e-12 ? 0 : contrib / R,
      riskContrib,
    };
  });

  rows.sort((x, y) => y.returnContrib - x.returnContrib);
  return { rows, weightRows, totalReturn: R };
}

// ── main entry ────────────────────────────────────────────────────────────────

/**
 * @param {object} data         parsed backtest-history.json
 * @param {string[]} includedTickers  bare symbols to include (e.g. ['BBCA','BBRI'])
 * @param {object} [opts]       { volHalfLife }
 * @returns {{ window, chart, metrics, latestWeights, warnings }}
 */
export function runBacktest(data, includedTickers, opts = {}) {
  const volHalfLife = opts.volHalfLife ?? DEFAULT_VOL_HALF_LIFE;
  const rf = data.riskFreeRate ?? 0.0575;
  const warnings = [];

  const byTicker = new Map(data.tickers.map(t => [t.ticker, t]));
  const included = includedTickers
    .map(t => byTicker.get(t))
    .filter(Boolean);

  if (included.length < 2) {
    return { window: null, chart: [], metrics: null, latestWeights: [], warnings: ['Select at least 2 tickers.'] };
  }

  // Precompute daily log-returns per asset.
  const dailyRet = included.map(a => dailyLogReturns(a.daily));

  // Canonical weekly grid + aligned prices. alignPriceSeries normalises .JK bars onto
  // a common Tuesday key, so Friday-anchored and Sunday-anchored series line up by
  // economic week (raw-string intersection would collapse to empty otherwise).
  const aligned = alignPriceSeries(included.map(a => ({ id: a.ticker, history: a.weekly })));
  const common = aligned.map(r => r.date);

  // Window start = newest listing + 1 calendar year.
  const newestListing = included.reduce(
    (mx, a) => (a.listing > mx ? a.listing : mx),
    included[0].listing,
  );
  const backtestStart = addCalendarDays(newestListing, CORR_WINDOW_DAYS);

  const startIdx = aligned.findIndex(r => r.date >= backtestStart);
  const rebalanceRows = startIdx >= 0 ? aligned.slice(startIdx) : [];
  const rebalanceWeeks = rebalanceRows.map(r => r.date);
  if (rebalanceRows.length < 3) {
    return {
      window: { start: backtestStart, end: common[common.length - 1] ?? null, newestListing, nRebalances: rebalanceRows.length },
      chart: [], metrics: null, latestWeights: [],
      warnings: [`Only ${rebalanceRows.length} weekly bar(s) after ${backtestStart} — drop the newest name(s) to lengthen the window.`],
    };
  }

  // Benchmark indexed by canonical week key (IHSG is itself Friday/Sunday-anchored).
  const benchByKey = new Map();
  data.benchmark.weekly.dates.forEach((d, i) => {
    const px = data.benchmark.weekly.adjClose[i];
    if (px != null) benchByKey.set(canonicalWeeklyKey(d), px); // last source bar wins
  });

  // Assets shaped for the correlation function (full weekly history; the function
  // filters to the [start, end] window we pass, so endISO = t prevents look-ahead).
  const corrAssets = included.map(a => ({ ticker: a.ticker, priceHistory: a.weekly }));

  const n = included.length;
  const eqW = 1 / n;

  const minVarRets = [], eqRets = [], ihsgRets = [];
  let latestWeights = [];
  let lookAheadViolation = null; // any daily bar used on/after the next rebalance week

  // Rebalance history (weight % per stock, chart-ready) + per-stock contribution
  // series c_k(t) = w_k(t)·r_k(t), kept for both portfolios for attribution.
  const weightRowsMV = [], weightRowsEW = [];
  const cMV = Array.from({ length: n }, () => []);
  const cEW = Array.from({ length: n }, () => []);

  for (let i = 0; i < rebalanceRows.length - 1; i++) {
    const row = rebalanceRows[i];
    const rowNext = rebalanceRows[i + 1];
    const t = row.date;        // canonical Tuesday key of the signal week
    const tNext = rowNext.date;
    const startISO = addCalendarDays(t, -CORR_WINDOW_DAYS);
    // Daily data is known through the signal week's close; the canonical key is the
    // week's Tuesday, so the Friday close is ~t+3. Cut at t+4 (Saturday) — still safely
    // before next week's Monday, so no bleed into tNext.
    const dailyCutoff = addCalendarDays(t, 4);

    // ρ over trailing 1yr weekly returns, ending at t.
    const { matrix, obs } = computeCorrelationFromDateRange(corrAssets, startISO, t);

    // σ from trailing daily returns ending at the signal week's close.
    const volAssets = included.map((a, k) => {
      const end = idxAtOrBefore(dailyRet[k].dates, dailyCutoff);
      // Only the trailing 252 returns matter (computeThetaDecayedVol slices last 252).
      const lo = Math.max(0, end + 1 - 252);
      const slice = end >= 0 ? dailyRet[k].vals.slice(lo, end + 1) : [];
      if (end >= 0 && dailyRet[k].dates[end] >= tNext && !lookAheadViolation) {
        lookAheadViolation = `${dailyRet[k].dates[end]} >= next week ${tNext}`;
      }
      // Single 'ALL' sector + an explicit cap of 1.0 below disables sector caps:
      // resolveSectorCap defaults absent sectors to DEFAULT_SECTOR_CAP (0.80), which
      // would otherwise cap the whole (one-sector) portfolio at 80% and leave ~20% cash.
      return { ticker: a.ticker, sector: 'ALL', meta: { dailyReturns: slice } };
    });

    const { covMatrix } = computeCovarianceMatrix(matrix, volAssets, {
      volHalfLife, shrinkage: true, nObs: obs,
    });

    const wMinVar = findMinVariancePortfolio(covMatrix, volAssets, { sectorCaps: { ALL: 1 }, maxPositionCap: 1 }, true);
    if (i === rebalanceRows.length - 2) {
      latestWeights = included.map((a, k) => ({ ticker: a.ticker, weight: wMinVar[k] }));
    }

    // Realized asset returns t → tNext (aligned weekly close prices).
    const mvRow = { date: t }, ewRow = { date: t };
    let mvRet = 0, ewRet = 0;
    for (let k = 0; k < n; k++) {
      const tk = included[k].ticker;
      const p0 = row[tk];
      const p1 = rowNext[tk];
      const r = p0 > 0 && p1 != null ? p1 / p0 - 1 : 0;
      mvRet += wMinVar[k] * r;
      ewRet += eqW * r;
      cMV[k].push(wMinVar[k] * r);
      cEW[k].push(eqW * r);
      mvRow[tk] = +(wMinVar[k] * 100).toFixed(3); // weight %, chart-ready
      ewRow[tk] = +(eqW * 100).toFixed(3);
    }
    minVarRets.push(mvRet);
    eqRets.push(ewRet);
    weightRowsMV.push(mvRow);
    weightRowsEW.push(ewRow);

    // IHSG realized return over the same span.
    const b0 = benchByKey.get(t);
    const b1 = benchByKey.get(tNext);
    ihsgRets.push(b0 > 0 && b1 != null ? b1 / b0 - 1 : 0);
  }

  if (lookAheadViolation) warnings.push(`Look-ahead guard tripped: ${lookAheadViolation}`);

  // Equity curves indexed to 100 at the first rebalance week.
  const mvEq = cumEquity(minVarRets);
  const ewEq = cumEquity(eqRets);
  const ihEq = cumEquity(ihsgRets);
  const chart = rebalanceWeeks.map((d, i) => ({
    date: d,
    MinVar: +mvEq[i].toFixed(2),
    EqualWeight: +ewEq[i].toFixed(2),
    IHSG: +ihEq[i].toFixed(2),
  }));

  const metrics = {
    MinVar: seriesMetrics(minVarRets, mvEq[mvEq.length - 1], rf, ihsgRets),
    EqualWeight: seriesMetrics(eqRets, ewEq[ewEq.length - 1], rf, ihsgRets),
    IHSG: seriesMetrics(ihsgRets, ihEq[ihEq.length - 1], rf, null),
  };

  return {
    window: {
      start: rebalanceWeeks[0],
      end: rebalanceWeeks[rebalanceWeeks.length - 1],
      newestListing,
      nRebalances: rebalanceWeeks.length,
      nTickers: n,
      riskFreeRate: rf,
    },
    chart,
    metrics,
    attribution: {
      MinVar: buildAttribution(included, weightRowsMV, cMV, minVarRets),
      EqualWeight: buildAttribution(included, weightRowsEW, cEW, eqRets),
    },
    latestWeights: latestWeights.sort((a, b) => b.weight - a.weight),
    warnings,
  };
}
