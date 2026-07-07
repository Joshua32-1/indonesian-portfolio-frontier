/**
 * backtestEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure-JS, cost-aware walk-forward backtest engine. No React / DOM / I/O. Three entry points
 * over the same per-step machinery: runBacktest (live min-variance vs equal-weight vs IHSG
 * explorer); runStrategyBacktest (precompute — the production tail-aware machinery: Max-Sharpe
 * + tail-λ variants — across weekly/monthly/quarterly with a turnover-penalty κ sweep); and
 * runLiveStrategy (single-frequency, in-browser Web Worker sibling).
 *
 * For each rebalance date t (using ONLY data ≤ t — no look-ahead):
 *   ρ  = weekly Pearson over the trailing 1 year      (computeCorrelationFromDateRange)
 *   σ  = theta-decay daily vol, halfLife 63, 252d      (computeThetaDecayedVol)
 *   Σ  = ρ·σ·σ with Ledoit-Wolf shrinkage              (computeCovarianceMatrix)
 *   w  = strategy weights (min-var / Max-Sharpe / tail-λ, per entry point)
 * then hold to the next rebalance and book the realized return. Returns are reported NET of an
 * IDX transaction-cost model (liquidity-aware half-spread + asymmetric buy/sell fees on
 * drift-adjusted turnover), with GROSS shown alongside. Equal-weight and IHSG are tracked too.
 *
 * Optional turnover penalty (opts.kappa > 0): the min-variance step is penalized toward
 * the drifted prior weights (minVarTurnoverPenalized), trading a little variance for less
 * weight churn → lower turnover and cost drag. κ = 0 (default) is an exact no-op. This is
 * min-variance-specific and distinct from the production tail-aware κ in optimizeTailAware.
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
import { findMinVariancePortfolio, optimizeTailAware } from '../../portfolio-app/src/math/monteCarlo.js';
import { makeRng } from '../../portfolio-app/src/math/robustObjective.js';
import { computeEquilibriumReturns, defaultDelta } from '../../portfolio-app/src/math/blackLitterman.js';

const CORR_WINDOW_DAYS = 365; // trailing 1-year weekly correlation window

// Unconstrained long-only optimizer constraints: a single synthetic 'ALL' sector capped at
// 1.0 and a per-name cap of 1.0 → neither binds (historical default). runLiveStrategy builds
// a tighter bundle when the user sets a position or sector cap.
const DEFAULT_CONSTRAINTS = { sectorCaps: { ALL: 1 }, maxPositionCap: 1 };

// Shares-outstanding fallback for names Yahoo returns 0/null for (else they'd get 0% equilibrium-
// prior weight — a real large-cap silently dropped from the cap prior). BNGA = Bank CIMB Niaga;
// Yahoo's sharesOutstanding is 0, but impliedSharesOutstanding & marketCap/price both give ~25.285B.
const SHARES_FALLBACK = { BNGA: 25_285_000_000 };

// Static ticker → sector labels (sourced from the optimizer's live-market-snapshot.json,
// assets[].sector). The backtest snapshot carries no sector field, and the universe is a
// fixed ≤25-name large-cap set, so a checked-in map is sufficient for sector caps.
const SECTOR_MAP = {
  BBCA: 'Financials', BBRI: 'Financials', BMRI: 'Financials', BBNI: 'Financials', BNGA: 'Financials',
  TLKM: 'Communication Services', ISAT: 'Communication Services',
  ASII: 'Industrials', UNTR: 'Industrials', JSMR: 'Industrials', AMRT: 'Consumer Defensive',
  INDF: 'Consumer Defensive', ICBP: 'Consumer Defensive', CPIN: 'Consumer Defensive',
  KLBF: 'Healthcare', SIDO: 'Healthcare',
  CMRY: 'Consumer Defensive', PWON: 'Real Estate', BIRD: 'Industrials',
  ANTM: 'Basic Materials', INCO: 'Basic Materials', MDKA: 'Basic Materials', NCKL: 'Basic Materials',
  AADI: 'Energy', LSIP: 'Consumer Defensive',
};

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

function seriesMetrics(periodRets, equityFinal, rf, benchRets, periodsPerYear = 52) {
  const nPeriods = periodRets.length;
  const sqrtPpy = Math.sqrt(periodsPerYear);
  const years = nPeriods / periodsPerYear;
  const annReturn = years > 0 ? Math.pow(equityFinal / 100, 1 / years) - 1 : 0;
  const annVol = stdev(periodRets) * sqrtPpy;
  const sharpe = annVol > 0 ? (annReturn - rf) / annVol : 0;
  const mdd = maxDrawdown(cumEquity(periodRets));

  const out = { annReturn, annVol, sharpe, maxDrawdown: mdd };
  if (benchRets) {
    const active = periodRets.map((r, i) => r - benchRets[i]);
    const tePeriod = stdev(active);
    out.trackingError = tePeriod * sqrtPpy;
    const varB = covariance(benchRets, benchRets);
    out.beta = varB > 0 ? covariance(periodRets, benchRets) / varB : 0;
    out.correlation = pearson(periodRets, benchRets);
    // Information ratio = annualized active return / tracking error.
    out.infoRatio = tePeriod > 1e-12 ? (mean(active) * sqrtPpy) / out.trackingError : 0;
    // t-stat of alpha ≈ IR · √years (significance of the active-return mean).
    out.tStat = out.infoRatio * Math.sqrt(years);
    // Hit rate = share of periods the strategy beat the benchmark.
    out.hitRate = nPeriods ? active.filter(a => a > 0).length / nPeriods : 0;
  }
  return out;
}

function cumEquity(weeklyRets) {
  const eq = [100];
  for (const r of weeklyRets) eq.push(eq[eq.length - 1] * (1 + r));
  return eq;
}

// ── transaction costs (IDX) ─────────────────────────────────────────────────────
//
// Per rebalance the book is moved from the DRIFTED prior weights to the new targets;
// each traded unit pays a half-spread (liquidity-dependent) plus an asymmetric IDX
// brokerage fee (buy ≈ 0.15%, sell ≈ 0.25% — the sell leg carries the transaction
// levy + final tax). Costs are subtracted from that period's gross return.

const COST = {
  feeBuyBps: 15,          // IDX brokerage, buy side
  feeSellBps: 25,         // IDX brokerage + levy + PPh final, sell side
  halfSpreadFloorBps: 5,  // most-liquid large-caps
  halfSpreadCeilBps: 50,  // thin names
  halfSpreadK: 30,        // halfSpreadBps = clamp(K / √ADV_bn, floor, ceil)
  flatPerSideBps: 35,     // fallback per unit traded when liquidity data is absent
  advWindow: 63,          // trailing sessions for the average-daily-value estimate
};

/** Liquidity-driven half-spread (bps) from trailing average daily value (IDR). */
function halfSpreadBps(advIDR) {
  if (!(advIDR > 0)) return COST.halfSpreadCeilBps;
  const advBn = advIDR / 1e9;
  const raw = COST.halfSpreadK / Math.sqrt(Math.max(advBn, 0.01));
  return Math.min(COST.halfSpreadCeilBps, Math.max(COST.halfSpreadFloorBps, raw));
}

/** Drift target weights by one period's realized asset returns → pre-rebalance weights. */
function driftWeights(wTarget, rVec) {
  const grown = wTarget.map((w, k) => w * (1 + (rVec[k] ?? 0)));
  const s = grown.reduce((a, v) => a + v, 0);
  return s > 1e-12 ? grown.map(v => v / s) : wTarget.slice();
}

/** One-way turnover ½·Σ|Δw| between target and (drifted) prior weights. */
function oneWayTurnover(wTarget, wPre) {
  return wTarget.reduce((s, w, k) => s + Math.abs(w - (wPre[k] ?? 0)), 0) / 2;
}

/**
 * Turnover-penalized minimum variance via a partial-rebalance (inertia) blend:
 *
 *     w = (1 − κ)·w_minvar + κ·w_drift
 *
 * where w_minvar is the fresh unpenalized min-variance target and w_drift is last step's
 * weights carried forward by realized returns. Both lie on the long-only simplex
 * (wₖ ≥ 0, Σw = 1), so the convex blend does too — no projection needed. This is the
 * closed-form L2-turnover-penalized direction (a "trade partway to target" scheme): the
 * deviation from the drifted prior, w − w_drift = (1−κ)(w_minvar − w_drift), shrinks by
 * exactly (1−κ), so turnover falls monotonically with κ. κ ∈ [0,1): 0 = full rebalance,
 * 0.5 = trade halfway, →1 = hold (zero turnover).
 *
 * With κ = 0 (or no prior drift) the unpenalized min-variance solution is returned
 * unchanged, so the κ-off path is byte-identical to findMinVariancePortfolio.
 */
function minVarTurnoverPenalized(covMatrix, volAssets, wDrift, kappa, constraints = DEFAULT_CONSTRAINTS) {
  const w0 = findMinVariancePortfolio(covMatrix, volAssets, constraints, true);
  if (!(kappa > 0) || !wDrift) return w0;
  const a = Math.min(Math.max(kappa, 0), 0.95); // clamp; never fully freeze
  return w0.map((x, k) => (1 - a) * x + a * wDrift[k]);
}

/**
 * Cost (fraction of portfolio) to move from wPre → wTarget.
 * advVec: trailing average daily value (IDR) per asset, or null for the flat model.
 */
function rebalanceCost(wTarget, wPre, advVec) {
  let cost = 0;
  for (let k = 0; k < wTarget.length; k++) {
    const delta = wTarget[k] - (wPre[k] ?? 0);
    if (Math.abs(delta) < 1e-12) continue;
    if (advVec) {
      const hs = halfSpreadBps(advVec[k]) / 1e4;
      const fee = (delta > 0 ? COST.feeBuyBps : COST.feeSellBps) / 1e4;
      cost += Math.abs(delta) * (hs + fee);
    } else {
      cost += Math.abs(delta) * (COST.flatPerSideBps / 1e4);
    }
  }
  return cost;
}

/**
 * Walk a weight path into net-of-cost returns + metrics.
 *   wByStep[i]  target weights at rebalance i (fractions)
 *   rByStep[i]  realized asset returns over period i → i+1
 *   grossRets[i] = wByStep[i] · rByStep[i]
 *   advByStep[i] trailing ADV per asset at rebalance i, or null (→ flat cost)
 * Period-0 trades from cash (wPre = 0): the one-time deployment cost.
 */
function buildCostedSeries(grossRets, wByStep, rByStep, advByStep, rf, benchRets, periodsPerYear = 52) {
  const T = grossRets.length;
  const n = wByStep[0]?.length ?? 0;
  const turnover = [], cost = [], netRets = [];
  let prevTarget = Array(n).fill(0); // start from cash
  for (let i = 0; i < T; i++) {
    const wPre = i === 0 ? prevTarget : driftWeights(prevTarget, rByStep[i - 1]);
    turnover.push(oneWayTurnover(wByStep[i], wPre));
    const c = rebalanceCost(wByStep[i], wPre, advByStep?.[i] ?? null);
    cost.push(c);
    netRets.push(grossRets[i] - c);
    prevTarget = wByStep[i];
  }
  const grossEq = cumEquity(grossRets);
  const netEq = cumEquity(netRets);
  const years = T / periodsPerYear;
  return {
    netRets, grossEq, netEq,
    gross: seriesMetrics(grossRets, grossEq[grossEq.length - 1], rf, benchRets, periodsPerYear),
    net: seriesMetrics(netRets, netEq[netEq.length - 1], rf, benchRets, periodsPerYear),
    annualTurnover: years > 0 ? turnover.reduce((a, v) => a + v, 0) / years : 0,
    annualCostDrag: years > 0 ? cost.reduce((a, v) => a + v, 0) / years : 0,
  };
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
  const kappa = opts.kappa ?? 0; // turnover penalty on the min-variance step (0 = off, exact baseline)
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

  // Per-asset daily dollar-volume (liquidity) aligned to daily dates, for the cost
  // model. Absent on pre-upgrade snapshots → fall back to the flat per-side cost.
  const dailyDV = included.map(a => ({ dates: a.daily.dates, dv: a.daily.dollarVol ?? null }));
  const hasLiquidity = dailyDV.every(x => Array.isArray(x.dv) && x.dv.length === x.dates.length);

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

  // Raw weight/return/liquidity paths for the cost model (filled per rebalance below).
  const wMVByStep = [], wEWByStep = [], rByStep = [], advByStep = [];
  const eqWeights = Array(n).fill(eqW);

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

    // κ>0: penalize the min-var target toward the prior step's drifted weights (less churn).
    const wDrift = kappa > 0 && i > 0 ? driftWeights(wMVByStep[i - 1], rByStep[i - 1]) : null;
    const wMinVar = minVarTurnoverPenalized(covMatrix, volAssets, wDrift, kappa);
    if (i === rebalanceRows.length - 2) {
      latestWeights = included.map((a, k) => ({ ticker: a.ticker, weight: wMinVar[k] }));
    }

    // Realized asset returns t → tNext (aligned weekly close prices).
    const mvRow = { date: t }, ewRow = { date: t };
    const rVec = new Array(n);
    let mvRet = 0, ewRet = 0;
    for (let k = 0; k < n; k++) {
      const tk = included[k].ticker;
      const p0 = row[tk];
      const p1 = rowNext[tk];
      const r = p0 > 0 && p1 != null ? p1 / p0 - 1 : 0;
      rVec[k] = r;
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

    // Cost-model paths: target weights, realized returns, and trailing ADV per asset.
    wMVByStep.push(wMinVar.slice());
    wEWByStep.push(eqWeights.slice());
    rByStep.push(rVec);
    if (hasLiquidity) {
      advByStep.push(included.map((a, k) => {
        const end = idxAtOrBefore(dailyDV[k].dates, dailyCutoff);
        if (end < 0) return 0;
        const lo = Math.max(0, end + 1 - COST.advWindow);
        const win = dailyDV[k].dv.slice(lo, end + 1);
        return win.length ? win.reduce((s, v) => s + v, 0) / win.length : 0;
      }));
    }

    // IHSG realized return over the same span.
    const b0 = benchByKey.get(t);
    const b1 = benchByKey.get(tNext);
    ihsgRets.push(b0 > 0 && b1 != null ? b1 / b0 - 1 : 0);
  }

  if (lookAheadViolation) warnings.push(`Look-ahead guard tripped: ${lookAheadViolation}`);

  // Cost-aware series: gross + net-of-cost equity curves and metrics per strategy.
  // IHSG is an index (no trading), so its net == gross.
  const adv = hasLiquidity ? advByStep : null;
  const costMV = buildCostedSeries(minVarRets, wMVByStep, rByStep, adv, rf, ihsgRets);
  const costEW = buildCostedSeries(eqRets, wEWByStep, rByStep, adv, rf, ihsgRets);
  const ihEq = cumEquity(ihsgRets);
  const ihMetrics = seriesMetrics(ihsgRets, ihEq[ihEq.length - 1], rf, null);

  const chart = rebalanceWeeks.map((d, i) => ({
    date: d,
    MinVar: +costMV.grossEq[i].toFixed(2),
    MinVarNet: +costMV.netEq[i].toFixed(2),
    EqualWeight: +costEW.grossEq[i].toFixed(2),
    EqualWeightNet: +costEW.netEq[i].toFixed(2),
    IHSG: +ihEq[i].toFixed(2),
  }));

  // Primary metric keys are NET-of-cost (the honest headline); gross Sharpe/return and
  // the turnover/cost-drag are carried alongside so the table can show the gap.
  const packMetrics = c => ({
    ...c.net,
    grossSharpe: c.gross.sharpe,
    grossAnnReturn: c.gross.annReturn,
    annualTurnover: c.annualTurnover,
    annualCostDrag: c.annualCostDrag,
  });
  const metrics = {
    MinVar: packMetrics(costMV),
    EqualWeight: packMetrics(costEW),
    IHSG: { ...ihMetrics, grossSharpe: ihMetrics.sharpe, grossAnnReturn: ihMetrics.annReturn, annualTurnover: 0, annualCostDrag: 0 },
  };

  return {
    window: {
      start: rebalanceWeeks[0],
      end: rebalanceWeeks[rebalanceWeeks.length - 1],
      newestListing,
      nRebalances: rebalanceWeeks.length,
      nTickers: n,
      riskFreeRate: rf,
      costModel: hasLiquidity ? 'liquidity-aware' : 'flat',
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

// ── strategy backtest (tail-aware machinery, costed, κ + frequency sweep) ────────
//
// Walk-forward backtest of the PRODUCTION optimization machinery — BL-equilibrium
// prior + tail-aware/CVaR objective + Ledoit-Wolf Σ + constraints — driven by an
// empirical (equilibrium-centered) return distribution. The analyst-target alpha
// signal is deliberately ABSENT: it cannot be historicized without point-in-time
// targets, so it is validated separately by the live forward-test, not here.
//
// Heavy (optimizes per step × per κ); intended for the Node precompute script that
// caches results to public/backtest-results.json, not live universe-toggle recompute.

const FREQUENCIES = {
  weekly: { step: 1, periodsPerYear: 52, label: 'Weekly' },
  monthly: { step: 4, periodsPerYear: 13, label: 'Monthly (4-wk)' },
  quarterly: { step: 13, periodsPerYear: 4, label: 'Quarterly (13-wk)' },
};

// Tail-objective variants charted side-by-side: Max-Sharpe (no tail penalty) plus
// Tail-Aware at increasing tail-penalty λ. All run at a fixed turnover penalty κ.
const VARIANTS = [
  { key: 'MaxSharpe', label: 'Max-Sharpe', mode: 'avgMuSharpe', tailPenalty: 0 },
  { key: 'Tail025', label: 'Tail λ=0.25', mode: 'tailAware', tailPenalty: 0.25 },
  { key: 'Tail05', label: 'Tail λ=0.5', mode: 'tailAware', tailPenalty: 0.5 },
  { key: 'Tail10', label: 'Tail λ=1.0', mode: 'tailAware', tailPenalty: 1.0 },
];

/** Build per-step context (Σ, μ_eq, realized returns, ADV) once for a rebalance grid. */
function buildStepContexts(grid, ctx) {
  const { corrAssets, dailyRet, dailyDV, included, hasLiquidity, volHalfLife,
    benchByKey, sharesOut, capMode, rf, priorMode = 'cap', useSectors = false } = ctx;
  const n = included.length;
  const contexts = [];
  let lookAhead = null;
  for (let i = 0; i < grid.length - 1; i++) {
    const row = grid[i], rowNext = grid[i + 1];
    const t = row.date, tNext = rowNext.date;
    const startISO = addCalendarDays(t, -CORR_WINDOW_DAYS);
    const dailyCutoff = addCalendarDays(t, 4);

    const { matrix, obs } = computeCorrelationFromDateRange(corrAssets, startISO, t);
    const volAssets = included.map((a, k) => {
      const end = idxAtOrBefore(dailyRet[k].dates, dailyCutoff);
      const lo = Math.max(0, end + 1 - 252);
      const slice = end >= 0 ? dailyRet[k].vals.slice(lo, end + 1) : [];
      if (end >= 0 && dailyRet[k].dates[end] >= tNext && !lookAhead) {
        lookAhead = `${dailyRet[k].dates[end]} >= next ${tNext}`;
      }
      // Real sector labels only when sector caps are active; otherwise a single synthetic
      // 'ALL' sector (preserves the unconstrained default and runStrategyBacktest behavior).
      const sector = useSectors ? (SECTOR_MAP[a.ticker] ?? 'Other') : 'ALL';
      return { ticker: a.ticker, sector, meta: { dailyReturns: slice } };
    });
    const { covMatrix } = computeCovarianceMatrix(matrix, volAssets, { volHalfLife, shrinkage: true, nObs: obs });

    // Equilibrium-prior reference weights w_prior. capMode='equal' (shares unreliable) forces
    // equal regardless of priorMode. Otherwise priorMode picks: 'cap' = market-cap (sharesOut ×
    // price(t)), 'equal' = 1/n, 'shrunk' = 50/50 blend (both inputs sum to 1 → blend does too).
    const equalW = Array(n).fill(1 / n);
    let capW;
    if (capMode !== 'cap' || priorMode === 'equal') {
      capW = equalW;
    } else {
      const caps = included.map((a, k) => {
        const px = row[a.ticker];
        return px > 0 && sharesOut[k] > 0 ? px * sharesOut[k] : 0;
      });
      const s = caps.reduce((acc, v) => acc + v, 0);
      const capRaw = s > 0 ? caps.map(v => v / s) : equalW;
      capW = priorMode === 'shrunk' ? capRaw.map((v, k) => 0.5 * v + 0.5 * equalW[k]) : capRaw;
    }
    const delta = defaultDelta(covMatrix, capW, rf);
    // computeEquilibriumReturns returns TOTAL returns (π = r_f + δ·Σ·w) — the space the shared
    // Sharpe objective expects (it subtracts r_f itself). Since the book is fully invested
    // (Σw=1), wᵀπ − r_f = wᵀ(δΣw), the true tangency numerator. Without the r_f gross-up in π,
    // the −r_f/σ term would reward variance → Max-Sharpe/Tail blow out into concentrated,
    // high-turnover portfolios.
    const muEq = computeEquilibriumReturns(covMatrix, capW, { riskFreeRate: rf, delta });

    const rVec = included.map(a => {
      const p0 = row[a.ticker], p1 = rowNext[a.ticker];
      return p0 > 0 && p1 != null ? p1 / p0 - 1 : 0;
    });
    const b0 = benchByKey.get(t), b1 = benchByKey.get(tNext);
    const ihsgRet = b0 > 0 && b1 != null ? b1 / b0 - 1 : 0;

    let advVec = null;
    if (hasLiquidity) {
      advVec = included.map((a, k) => {
        const end = idxAtOrBefore(dailyDV[k].dates, dailyCutoff);
        if (end < 0) return 0;
        const lo = Math.max(0, end + 1 - COST.advWindow);
        const win = dailyDV[k].dv.slice(lo, end + 1);
        return win.length ? win.reduce((s, v) => s + v, 0) / win.length : 0;
      });
    }
    contexts.push({ t, tNext, covMatrix, volAssets, muEq, rVec, advVec, ihsgRet });
  }
  return { contexts, lookAhead };
}

/**
 * Min-variance weight path on a grid. κ = 0 → each step independent & deterministic
 * (identical to the historical behavior). κ > 0 → each step is penalized toward the prior
 * step's drifted weights via minVarTurnoverPenalized, so the walk is sequential.
 */
function walkMinVar(contexts, kappa = 0, constraints = DEFAULT_CONSTRAINTS) {
  const weights = [];
  for (let i = 0; i < contexts.length; i++) {
    const c = contexts[i];
    const wDrift = kappa > 0 && i > 0 ? driftWeights(weights[i - 1], contexts[i - 1].rVec) : null;
    weights.push(minVarTurnoverPenalized(c.covMatrix, c.volAssets, wDrift, kappa, constraints));
  }
  return weights;
}

/**
 * Apply a uniform partial-rebalance (inertia) turnover penalty to ANY pre-computed weight
 * path: each step trades only (1−κ) of the way to its target, blending toward the prior
 * step's drifted weights — wᵢ ← (1−a)·wᵢ + a·drift(wᵢ₋₁). Same well-defined, simplex-safe,
 * monotone blend used by minVarTurnoverPenalized, so κ means the SAME thing across every
 * strategy (Max-Sharpe, Tail, Min-Var) rather than relying on the optimizer's native
 * turnover term — which the avgMuSharpe (Max-Sharpe) objective ignores entirely. κ = 0 → no-op.
 */
function blendTowardDrift(weights, contexts, kappa) {
  if (!(kappa > 0) || !weights.length) return weights;
  const a = Math.min(Math.max(kappa, 0), 0.95);
  const out = [weights[0].slice()];
  for (let i = 1; i < weights.length; i++) {
    const wDrift = driftWeights(out[i - 1], contexts[i - 1].rVec);
    out.push(weights[i].map((x, k) => (1 - a) * x + a * wDrift[k]));
  }
  return out;
}

/**
 * Project a long-only weight vector (Σw = 1) onto the box + group caps
 * {0 ≤ wᵢ ≤ maxPos, Σ_{i∈s} wᵢ ≤ secCap ∀ sector s} via iterative waterfilling — a
 * "cap each holding / each sector and redistribute the excess pro-rata to names with
 * headroom" scheme. Applied POST-optimization (the optimizer runs unconstrained, which is
 * ~10× faster across a walk-forward than re-enforcing caps inside every hill-climb step).
 * Cheap (O(iters·n)); deterministic. Approximate only when both caps bind together.
 */
function capVector(w, maxPos, secCap, sectorOf) {
  const n = w.length;
  const EPS = 1e-9;
  const nameMax = maxPos < 1 ? maxPos : 1;
  let x = w.slice();
  for (let it = 0; it < 100; it++) {
    let viol = false;
    // Per-name cap: clip, redistribute excess to names with headroom.
    if (maxPos < 1) {
      let excess = 0;
      for (let i = 0; i < n; i++) if (x[i] > maxPos + EPS) { excess += x[i] - maxPos; x[i] = maxPos; viol = true; }
      while (excess > EPS) {
        let head = 0;
        for (let i = 0; i < n; i++) head += Math.max(0, maxPos - x[i]);
        if (head < EPS) break;
        const add = Math.min(excess, head);
        for (let i = 0; i < n; i++) { const room = Math.max(0, maxPos - x[i]); if (room > 0) x[i] += add * (room / head); }
        excess -= add;
      }
    }
    // Per-sector cap: scale down over-cap sectors, push excess to under-cap sectors
    // (respecting the per-name cap so the two don't fight indefinitely).
    if (secCap < 1) {
      const sum = {};
      for (let i = 0; i < n; i++) sum[sectorOf[i]] = (sum[sectorOf[i]] || 0) + x[i];
      let excess = 0;
      for (let i = 0; i < n; i++) {
        const s = sectorOf[i];
        if (sum[s] > secCap + EPS) { const scale = secCap / sum[s]; excess += x[i] * (1 - scale); x[i] *= scale; viol = true; }
      }
      while (excess > EPS) {
        const sumNow = {};
        for (let i = 0; i < n; i++) sumNow[sectorOf[i]] = (sumNow[sectorOf[i]] || 0) + x[i];
        let head = 0;
        const room = new Array(n);
        for (let i = 0; i < n; i++) {
          room[i] = Math.max(0, Math.min(secCap - sumNow[sectorOf[i]], nameMax - x[i]));
          head += room[i];
        }
        if (head < EPS) break;
        const add = Math.min(excess, head);
        for (let i = 0; i < n; i++) if (room[i] > 0) x[i] += add * (room[i] / head);
        excess -= add;
      }
    }
    if (!viol) break;
  }
  const s = x.reduce((a, v) => a + v, 0); // renormalize any numerical residual
  return s > EPS ? x.map(v => v / s) : x;
}

/**
 * Strategy weight path on a grid (sequential: turnover penalty links steps via drift).
 * mode 'avgMuSharpe' = Max-Sharpe (no tail penalty); 'tailAware' = tail-penalty λ.
 *
 * `seed` (optional): when set, each step i draws its Monte-Carlo tail shocks from
 * makeRng((seed + i) >>> 0). Using the SAME (seed, step) across every variant AND the
 * κ-sweep gives common random numbers — shared noise cancels in their differences, so
 * the comparisons are sharper and byte-reproducible. seed == null ⇒ Math.random (jitters).
 */
function walkVariant(contexts, { mode, tailPenalty, kappa, paths, optimizeMaxIter, rf, seed = null, constraints = DEFAULT_CONSTRAINTS }) {
  const weights = [];
  for (let i = 0; i < contexts.length; i++) {
    const c = contexts[i];
    const scenarios = Array.from({ length: paths }, () => c.muEq); // empirical = equilibrium-centered
    const currentWeights = kappa > 0 && i > 0 ? driftWeights(weights[i - 1], contexts[i - 1].rVec) : null;
    const rng = seed != null ? makeRng((seed + i) >>> 0) : Math.random;
    const { weights: w } = optimizeTailAware(scenarios, c.covMatrix, c.volAssets, {
      sectorCaps: constraints.sectorCaps, maxPositionCap: constraints.maxPositionCap, riskFreeRate: rf,
      robustMode: mode, tailPenalty, turnoverPenalty: kappa, currentWeights,
      deterministicStarts: true, optimizeMaxIter, rng,
    });
    weights.push(w);
  }
  return weights;
}

/** Cost the realized path of a weight sequence over its grid. */
function costStrategy(weights, contexts, hasLiquidity, rf, benchRets, ppy) {
  const grossRets = weights.map((w, i) => w.reduce((s, wk, k) => s + wk * contexts[i].rVec[k], 0));
  const rByStep = contexts.map(c => c.rVec);
  const advByStep = hasLiquidity ? contexts.map(c => c.advVec) : null;
  return buildCostedSeries(grossRets, weights, rByStep, advByStep, rf, benchRets, ppy);
}

/** Net-headline metric pack shared by the strategy backtests (net primary, gross alongside). */
const packNet = c => ({
  annReturn: c.net.annReturn, annVol: c.net.annVol, sharpe: c.net.sharpe,
  grossSharpe: c.gross.sharpe, grossAnnReturn: c.gross.annReturn,
  maxDrawdown: c.net.maxDrawdown, infoRatio: c.net.infoRatio, tStat: c.net.tStat,
  hitRate: c.net.hitRate, trackingError: c.net.trackingError, beta: c.net.beta,
  annualTurnover: c.annualTurnover, annualCostDrag: c.annualCostDrag,
});

/** Per-stock return + risk attribution for one strategy's weight path over a context grid. */
function attributionFor(included, weights, contexts) {
  const n = included.length;
  const weightRows = contexts.map((c, i) => {
    const row = { date: c.t };
    for (let k = 0; k < n; k++) row[included[k].ticker] = +(weights[i][k] * 100).toFixed(3);
    return row;
  });
  const cByAsset = Array.from({ length: n }, () => []);
  const grossRets = weights.map((w, i) => {
    let g = 0;
    for (let k = 0; k < n; k++) { const cc = w[k] * contexts[i].rVec[k]; cByAsset[k].push(cc); g += cc; }
    return g;
  });
  return buildAttribution(included, weightRows, cByAsset, grossRets);
}

/**
 * Shared setup for both strategy backtests: resolve the included universe, liquidity/cost
 * mode, equilibrium-prior cap mode, the weekly rebalance grid, and the per-step context
 * inputs (sharedCtx for buildStepContexts). Returns { ok:false, warnings } on bad input
 * rather than throwing.
 */
function prepareStrategyInputs(data, includedTickers, volHalfLife) {
  const rf = data.riskFreeRate ?? 0.0575;
  const warnings = [];
  const byTicker = new Map(data.tickers.map(t => [t.ticker, t]));
  const included = includedTickers.map(t => byTicker.get(t)).filter(Boolean);
  if (included.length < 2) return { ok: false, warnings: ['Select at least 2 tickers.'] };

  const dailyRet = included.map(a => dailyLogReturns(a.daily));
  const dailyDV = included.map(a => ({ dates: a.daily.dates, dv: a.daily.dollarVol ?? null }));
  const hasLiquidity = dailyDV.every(x => Array.isArray(x.dv) && x.dv.length === x.dates.length);
  const sharesOut = included.map(a => {
    const s = Number.isFinite(a.sharesOut) && a.sharesOut > 0 ? a.sharesOut : (SHARES_FALLBACK[a.ticker] ?? 0);
    return s;
  });
  const nWithShares = sharesOut.filter(s => s > 0).length;
  const capMode = nWithShares >= Math.ceil(0.7 * included.length) ? 'cap' : 'equal';
  if (capMode === 'cap' && nWithShares < included.length) {
    warnings.push(`${included.length - nWithShares} name(s) missing shares-outstanding — given zero equilibrium-prior weight.`);
  } else if (capMode === 'equal') {
    warnings.push('Too few names with shares-outstanding — equilibrium prior falls back to equal cap weights.');
  }
  if (!hasLiquidity) warnings.push('No dollar-volume in snapshot — using flat per-side transaction cost.');

  const aligned = alignPriceSeries(included.map(a => ({ id: a.ticker, history: a.weekly })));
  const newestListing = included.reduce((mx, a) => (a.listing > mx ? a.listing : mx), included[0].listing);
  const backtestStart = addCalendarDays(newestListing, CORR_WINDOW_DAYS);
  const startIdx = aligned.findIndex(r => r.date >= backtestStart);
  const rebalanceRows = startIdx >= 0 ? aligned.slice(startIdx) : [];
  if (rebalanceRows.length < 12) {
    return { ok: false, warnings: [`Only ${rebalanceRows.length} weekly bars after ${backtestStart} — window too short for a strategy backtest.`] };
  }

  const benchByKey = new Map();
  data.benchmark.weekly.dates.forEach((d, i) => {
    const px = data.benchmark.weekly.adjClose[i];
    if (px != null) benchByKey.set(canonicalWeeklyKey(d), px);
  });
  const corrAssets = included.map(a => ({ ticker: a.ticker, priceHistory: a.weekly }));
  const sharedCtx = { corrAssets, dailyRet, dailyDV, included, hasLiquidity, volHalfLife, benchByKey, sharesOut, capMode, rf };
  return { ok: true, rf, warnings, included, hasLiquidity, capMode, rebalanceRows, newestListing, sharedCtx };
}

/**
 * Costed, statistically-reported walk-forward of the tail-aware machinery vs
 * min-variance / equal-weight / IHSG, with a turnover-penalty (κ) sweep and a
 * rebalance-frequency comparison.
 *
 * @param {object}   data            parsed backtest-history.json
 * @param {string[]} includedTickers bare symbols
 * @param {object}   [opts]  { kappas, frequencies, paths, tailPenalty, volHalfLife }
 */
export function runStrategyBacktest(data, includedTickers, opts = {}) {
  const {
    variants = VARIANTS,            // tail-objective variants charted side-by-side
    kappa = 0.25,                   // fixed turnover penalty for the variant curves
    kappaSweep = [0, 0.05, 0.1, 0.25, 0.5], // κ values tabulated per frequency
    frequencies = ['weekly', 'monthly', 'quarterly'],
    paths = 200,
    tailPenalty = 0.5,              // reference λ used for the κ-sweep
    optimizeMaxIter = 100,          // hill-climb iterations; lower = faster precompute
    volHalfLife = DEFAULT_VOL_HALF_LIFE,
    seed = 12345,                   // fixed RNG seed ⇒ byte-reproducible + common random numbers
    priorMode = 'cap',              // BL-equilibrium prior weights: 'cap' | 'shrunk' | 'equal'
  } = opts;

  const prep = prepareStrategyInputs(data, includedTickers, volHalfLife);
  if (!prep.ok) return { ok: false, warnings: prep.warnings };
  const { rf, warnings, included, hasLiquidity, capMode, rebalanceRows, newestListing, sharedCtx } = prep;

  const byFrequency = {};
  let lookAheadAny = null;
  const round2 = arr => arr.map(v => +v.toFixed(2));

  for (const freqKey of frequencies) {
    const freq = FREQUENCIES[freqKey];
    if (!freq) continue;
    const grid = rebalanceRows.filter((_, i) => i % freq.step === 0);
    if (grid.length < 6) { warnings.push(`${freqKey}: too few rebalances (${grid.length}).`); continue; }
    const ppy = freq.periodsPerYear;

    const { contexts, lookAhead } = buildStepContexts(grid, { ...sharedCtx, priorMode });
    if (lookAhead && !lookAheadAny) lookAheadAny = lookAhead;
    const benchRets = contexts.map(c => c.ihsgRet);
    const dates = [...contexts.map(c => c.t), grid[grid.length - 1].date];

    // Baselines on this grid.
    const mvW = walkMinVar(contexts);
    const ewW = contexts.map(() => Array(included.length).fill(1 / included.length));
    const costMV = costStrategy(mvW, contexts, hasLiquidity, rf, benchRets, ppy);
    const costEW = costStrategy(ewW, contexts, hasLiquidity, rf, benchRets, ppy);
    const ihEq = cumEquity(benchRets);
    const ihMetrics = seriesMetrics(benchRets, ihEq[ihEq.length - 1], rf, null, ppy);

    // Tail-objective variants (Max-Sharpe + tail-λ levels) at the fixed κ.
    const curves = {};
    const metrics = {};
    for (const v of variants) {
      const w = walkVariant(contexts, { mode: v.mode, tailPenalty: v.tailPenalty, kappa, paths, optimizeMaxIter, rf, seed });
      const costed = costStrategy(w, contexts, hasLiquidity, rf, benchRets, ppy);
      curves[v.key] = { grossEq: round2(costed.grossEq), netEq: round2(costed.netEq) };
      metrics[v.key] = packNet(costed);
    }
    curves.MinVar = { grossEq: round2(costMV.grossEq), netEq: round2(costMV.netEq) };
    curves.EqualWeight = { grossEq: round2(costEW.grossEq), netEq: round2(costEW.netEq) };
    curves.IHSG = { eq: round2(ihEq) };
    metrics.MinVar = packNet(costMV);
    metrics.EqualWeight = packNet(costEW);
    metrics.IHSG = { ...ihMetrics, grossSharpe: ihMetrics.sharpe, grossAnnReturn: ihMetrics.annReturn, annualTurnover: 0, annualCostDrag: 0 };

    // κ-sweep at the reference variant λ (tailPenalty) — run for EVERY frequency.
    const sweep = kappaSweep.map(k => {
      const w = walkVariant(contexts, { mode: 'tailAware', tailPenalty, kappa: k, paths, optimizeMaxIter, rf, seed });
      return { kappa: k, ...packNet(costStrategy(w, contexts, hasLiquidity, rf, benchRets, ppy)) };
    });

    byFrequency[freqKey] = { label: freq.label, nRebalances: grid.length, dates, curves, metrics, kappaSweep: sweep };
  }

  if (lookAheadAny) warnings.push(`Look-ahead guard tripped: ${lookAheadAny}`);

  // Default selector state: monthly (if present) net, best variant by net Sharpe.
  const defaultFreq = frequencies.find(f => byFrequency[f] && f === 'monthly') || Object.keys(byFrequency)[0];
  let headline = null;
  if (defaultFreq && byFrequency[defaultFreq]) {
    const m = byFrequency[defaultFreq].metrics;
    let bestVariant = null;
    for (const v of variants) {
      if (m[v.key] && (!bestVariant || m[v.key].sharpe > m[bestVariant].sharpe)) bestVariant = v.key;
    }
    headline = { frequency: defaultFreq, feeMode: 'net', bestVariant, kappa };
  }

  return {
    ok: true,
    params: {
      variants: variants.map(v => ({ key: v.key, label: v.label, mode: v.mode, tailPenalty: v.tailPenalty })),
      lambdas: variants.filter(v => v.mode === 'tailAware').map(v => v.tailPenalty),
      kappa, kappaSweep, frequencies, paths, tailPenalty,
      seed, priorMode, capMode, costModel: hasLiquidity ? 'liquidity-aware' : 'flat',
    },
    window: { start: rebalanceRows[0]?.date, end: rebalanceRows[rebalanceRows.length - 1]?.date, newestListing, nTickers: included.length, riskFreeRate: rf },
    byFrequency,
    headline,
    limitations: [
      'Machinery-only: the analyst-target alpha signal is absent (not historicizable). It is validated by the live forward-test, not this backtest.',
      'Survivorship bias: the universe is the currently-liquid IDX large-caps; delisted/shrunken names are excluded.',
      'Cap-weight approximation: the equilibrium prior uses current shares-outstanding (Yahoo exposes no history) × point-in-time price.',
      'Return scenarios are equilibrium-centered with the trailing Σ; they are not the production PERT-from-targets distribution.',
    ],
    warnings,
  };
}

// ── live strategy backtest (single frequency, in-browser via Web Worker) ─────────
//
// A lighter sibling of runStrategyBacktest for LIVE recompute on a user-selected
// universe: ONE frequency, ONE tail-λ variant (+ Max-Sharpe, Min-Var, Equal-Wt, IHSG),
// NO κ-sweep, with per-strategy return/risk attribution and fee drag. Tuned to run in a
// worker (lower optimizeMaxIter / fewer scenarios) so the full machinery is interactive.
//
// κ (turnover penalty) is applied UNIFORMLY as a partial-rebalance blend across Max-Sharpe,
// Tail and Min-Var (trade only (1−κ) of the way to target) — one consistent, monotone
// meaning for the toggle. Equal-Wt and IHSG are κ-independent.

/**
 * @param {object}   data            parsed backtest-history.json
 * @param {string[]} includedTickers bare symbols
 * @param {object}   [opts]  { frequency, lambda, kappa, maxPositionCap, priorMode, sectorCap,
 *                             paths, optimizeMaxIter, volHalfLife, onProgress }
 * @returns {{ ok, frequency, window, dates, curves, metrics, attribution, fees, strategies, warnings }}
 */
export function runLiveStrategy(data, includedTickers, opts = {}) {
  const {
    frequency = 'quarterly',
    lambda = 0.25,                  // selected tail-λ for the single Tail variant
    kappa = 0,                      // turnover penalty (0 = off); applies to variants + Min-Var
    paths = 60,                     // scenario count → tail subsample size. Dominant cost lever:
                                    // ~127ms/call at 60 vs ~244ms at 120; below ~60 the CVaR tail
                                    // estimate gets noisy. Offline precompute uses 200.
    optimizeMaxIter = 20,           // hill-climb iters; live default < offline (35) for speed
    volHalfLife = DEFAULT_VOL_HALF_LIFE,
    onProgress = null,              // (done, total, label) — forwarded by the worker
    maxPositionCap = 1,             // per-name weight cap (1 = off); reins in every strategy
    priorMode = 'cap',             // BL prior reference weights: 'cap' | 'shrunk' | 'equal'
    sectorCap = null,              // per-sector weight cap (null/≥1 = off); needs SECTOR_MAP
    seed = 12345,                  // fixed RNG seed ⇒ identical settings give identical curves
                                   // (no Monte-Carlo jitter on recompute); pass null for live noise
  } = opts;

  const freq = FREQUENCIES[frequency];
  if (!freq) return { ok: false, warnings: [`Unknown frequency '${frequency}'.`] };

  const prep = prepareStrategyInputs(data, includedTickers, volHalfLife);
  if (!prep.ok) return { ok: false, warnings: prep.warnings };
  const { rf, warnings, included, hasLiquidity, capMode, rebalanceRows, newestListing, sharedCtx } = prep;

  const grid = rebalanceRows.filter((_, i) => i % freq.step === 0);
  if (grid.length < 6) return { ok: false, warnings: [`${freq.label}: too few rebalances (${grid.length}).`] };
  const ppy = freq.periodsPerYear;

  // Caps are enforced POST-optimization (capVector), not inside the optimizer: enforcing
  // them in every hill-climb step makes a walk-forward ~10× slower (capped Tail goes from
  // seconds to minutes). Optimize unconstrained, then project each step's target onto the caps.
  const secCapVal = sectorCap != null && sectorCap < 1 ? sectorCap : 1;
  const capsActive = maxPositionCap < 1 || secCapVal < 1;
  const sectorOf = included.map(a => SECTOR_MAP[a.ticker] ?? 'Other');
  const capPath = weights => (capsActive ? weights.map(w => capVector(w, maxPositionCap, secCapVal, sectorOf)) : weights);

  // Feasibility: the most that can be invested while honoring the caps is
  // Σ_sectors min(secCap, namesInSector × maxPos), bounded by n × maxPos. If that's < 1 the
  // caps can't sum to 100%, so capVector's renormalize would scale weights back over the cap.
  // Warn rather than silently present a cap-violating portfolio.
  if (capsActive) {
    const bySector = {};
    for (const s of sectorOf) bySector[s] = (bySector[s] || 0) + 1;
    let maxInvest = 0;
    for (const s in bySector) maxInvest += Math.min(secCapVal, bySector[s] * maxPositionCap);
    maxInvest = Math.min(maxInvest, included.length * maxPositionCap);
    if (maxInvest < 1 - 1e-6) {
      warnings.push(`Caps too tight for this universe — at most ${(maxInvest * 100).toFixed(0)}% is investable under the chosen stock/sector caps, so the optimized strategies can't fully honor them (loosen a cap or add names).`);
    }
  }

  const { contexts, lookAhead } = buildStepContexts(grid, { ...sharedCtx, priorMode });
  if (lookAhead) warnings.push(`Look-ahead guard tripped: ${lookAhead}`);
  const benchRets = contexts.map(c => c.ihsgRet);
  const dates = [...contexts.map(c => c.t), grid[grid.length - 1].date];
  const round2 = arr => arr.map(v => +v.toFixed(2));
  const n = included.length;

  const total = 4; // optimized + baseline strategies that report progress
  let done = 0;
  const progress = label => { if (onProgress) onProgress(done, total, label); };

  const curves = {}, metrics = {}, attribution = {}, fees = {};
  const addStrategy = (key, weights) => {
    const costed = costStrategy(weights, contexts, hasLiquidity, rf, benchRets, ppy);
    curves[key] = { grossEq: round2(costed.grossEq), netEq: round2(costed.netEq) };
    metrics[key] = packNet(costed);
    attribution[key] = attributionFor(included, weights, contexts);
    const gFin = costed.grossEq[costed.grossEq.length - 1];
    const nFin = costed.netEq[costed.netEq.length - 1];
    fees[key] = { annualCostDrag: costed.annualCostDrag, annualTurnover: costed.annualTurnover, totalFee: +(gFin - nFin).toFixed(2) };
  };

  // Optimized variants (heavy): Max-Sharpe + the selected tail-λ. Optimize UNPENALIZED
  // (kappa: 0), then apply the uniform partial-rebalance blend so κ acts identically across
  // strategies — the avgMuSharpe (Max-Sharpe) objective ignores the optimizer's native
  // turnover term, so relying on it would silently leave Max-Sharpe un-penalized.
  progress('Optimizing Max-Sharpe…');
  addStrategy('MaxSharpe', capPath(blendTowardDrift(
    walkVariant(contexts, { mode: 'avgMuSharpe', tailPenalty: 0, kappa: 0, paths, optimizeMaxIter, rf, seed }), contexts, kappa)));
  done += 1;
  progress(`Optimizing Tail λ=${lambda}…`);
  addStrategy('Tail', capPath(blendTowardDrift(
    walkVariant(contexts, { mode: 'tailAware', tailPenalty: lambda, kappa: 0, paths, optimizeMaxIter, rf, seed }), contexts, kappa)));
  done += 1;

  // Baselines: Min-Var honors κ via the same blend (minVarTurnoverPenalized) then the caps;
  // Equal-Wt is a constant target (already satisfies any cap with this universe).
  progress('Min-variance…');
  addStrategy('MinVar', capPath(walkMinVar(contexts, kappa)));
  done += 1;
  addStrategy('EqualWeight', contexts.map(() => Array(n).fill(1 / n)));
  done += 1;
  progress('Finalizing…');

  // IHSG (index — net == gross, no attribution).
  const ihEq = cumEquity(benchRets);
  const ihMetrics = seriesMetrics(benchRets, ihEq[ihEq.length - 1], rf, null, ppy);
  curves.IHSG = { eq: round2(ihEq) };
  metrics.IHSG = { ...ihMetrics, grossSharpe: ihMetrics.sharpe, grossAnnReturn: ihMetrics.annReturn, annualTurnover: 0, annualCostDrag: 0 };

  return {
    ok: true,
    frequency,
    params: { lambda, kappa, maxPositionCap, priorMode, sectorCap, paths, optimizeMaxIter, capMode, costModel: hasLiquidity ? 'liquidity-aware' : 'flat' },
    window: {
      start: dates[0], end: dates[dates.length - 1], newestListing,
      nRebalances: grid.length, nTickers: n, riskFreeRate: rf,
      costModel: hasLiquidity ? 'liquidity-aware' : 'flat',
    },
    dates,
    curves,
    metrics,
    attribution,
    fees,
    strategies: ['MaxSharpe', 'Tail', 'MinVar', 'EqualWeight', 'IHSG'],
    warnings,
  };
}
