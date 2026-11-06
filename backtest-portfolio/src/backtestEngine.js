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
import {
  computeEquilibriumReturns, defaultDelta,
  computeViewUncertainty, blackLittermanPosterior,
} from '../../portfolio-app/src/math/blackLitterman.js';
import { makeViewLookup, DEFAULT_MAX_STALENESS_DAYS } from '../../portfolio-app/data/analyst-views.js';
import { makeRateLookup, meanRateOver, perPeriodRate, BI_RATE_FALLBACK, INSTRUMENT_SWITCH_DATE } from '../../portfolio-app/data/bi-rate.js';
import { sharpeFromExcess } from '../../portfolio-app/src/math/performance.js';
import { snapshotAsOf } from '../../portfolio-app/data/index-members.js';

const CORR_WINDOW_DAYS = 365; // trailing 1-year weekly correlation window
const TRADING_DAYS = 252;             // annualization factor; mirrors matrixEngine's SQRT_252
const MIN_SAMPLE_MEAN_OBS = 60;       // ~1 quarter — below this a sample mean is noise, not an estimate

// Valid μ sources. The first three are Black-Litterman equilibrium priors (μ reverse-optimized
// from reference weights); 'none' skips the prior and estimates μ from the trailing window.
// Validated rather than defaulted: an unrecognised string used to fall through to the 'cap'
// branch, so a typo produced a cap-prior run reported under the misspelled name.
export const PRIOR_MODES = ['cap', 'shrunk', 'equal', 'none'];

// Valid μ SIGNAL sources — orthogonal to PRIOR_MODES, which only sets the ANCHOR.
//
//   'off'      no views. μ is the anchor itself (π), or the trailing sample mean when
//              priorMode is 'none'. This is the historical behavior, bit-for-bit.
//   'analyst'  analyst 12-month targets where the archive covers the name at that step.
//              Names with no view keep the anchor — they are simply not tilted.
//   'hybrid'   analyst targets where available, TRAILING 1-YEAR SAMPLE MEAN everywhere
//              else, so every name always carries an expected return.
//   'sample'   the trailing sample mean for every name, expressed as a view. With
//              priorMode 'none' this reproduces plain Markowitz exactly.
export const VIEW_MODES = ['off', 'analyst', 'hybrid', 'sample'];

// Ω for a view that came from a trailing sample mean rather than an analyst: no coverage
// and no dispersion, so computeViewUncertainty's coverage term (maxAnalysts/1)^conf makes
// it a deliberately LOW-confidence view. That is the intended reading — a sample mean is
// the noisiest input in the problem — and it is why 'hybrid' does not simply overwrite π.
const SAMPLE_VIEW_ANALYSTS = 1;

/**
 * Earliest date the walk-forward is allowed to start, independent of listing dates.
 *
 * Defaults to the 2016-08-19 policy-instrument change: before it the policy rate was the
 * legacy BI Rate (a 12-month reference, ~6.50%); on it Bank Indonesia switched to the
 * 7-Day Reverse Repo Rate (~5.25%). A window that straddles the switch puts a ~125 bp step
 * in r_f that is an instrument change, not a policy move — so every Sharpe spanning it is
 * computed against two different definitions of "risk-free" spliced together.
 *
 * Starting here costs ~4.5 years of window and buys one consistent instrument throughout.
 * Pass windowStart: null to opt out and run the full spliced history instead.
 */
export const DEFAULT_WINDOW_START = INSTRUMENT_SWITCH_DATE;

/** Later of two ISO dates; tolerates either being null/empty. */
function laterISO(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

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

/**
 * @param {number[]} periodRets
 * @param {number} equityFinal
 * @param {number[]|number} rfPeriod  per-period risk-free rate(s), aligned to periodRets
 *   (array = the dated case). NOT an annual scalar — callers de-annualize via
 *   perPeriodRate so each period is charged the rate actually in effect during it.
 * @param {number[]|null} benchRets
 * @param {number} periodsPerYear
 */
function seriesMetrics(periodRets, equityFinal, rfPeriod, benchRets, periodsPerYear = 52) {
  const nPeriods = periodRets.length;
  const sqrtPpy = Math.sqrt(periodsPerYear);
  const years = nPeriods / periodsPerYear;
  // annReturn stays GEOMETRIC — it is the honest "what you earned" number shown in the UI.
  // Sharpe deliberately does not reconstruct from it (see performance.js).
  const annReturn = years > 0 ? Math.pow(equityFinal / 100, 1 / years) - 1 : 0;
  const annVol = stdev(periodRets) * sqrtPpy;
  const sharpe = sharpeFromExcess(periodRets, rfPeriod, periodsPerYear);
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
function buildCostedSeries(grossRets, wByStep, rByStep, advByStep, rfPeriod, benchRets, periodsPerYear = 52) {
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
    gross: seriesMetrics(grossRets, grossEq[grossEq.length - 1], rfPeriod, benchRets, periodsPerYear),
    net: seriesMetrics(netRets, netEq[netEq.length - 1], rfPeriod, benchRets, periodsPerYear),
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
  const rf = data.riskFreeRate ?? BI_RATE_FALLBACK;
  // Dated r_f: each rebalance is scored at the policy rate in effect ON that date, so a
  // 2013 step never sees a rate BI had not set yet. Absent a series this collapses to the
  // scalar, reproducing prior results exactly.
  const rfAt = makeRateLookup(data.riskFreeRateSeries, rf);
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
  // Charge each period the rate in effect at its OPEN — known at t, so no look-ahead.
  const rfPeriod = rebalanceWeeks.slice(0, minVarRets.length).map(d => perPeriodRate(rfAt(d), 52));
  const costMV = buildCostedSeries(minVarRets, wMVByStep, rByStep, adv, rfPeriod, ihsgRets);
  const costEW = buildCostedSeries(eqRets, wEWByStep, rByStep, adv, rfPeriod, ihsgRets);
  const ihEq = cumEquity(ihsgRets);
  const ihMetrics = seriesMetrics(ihsgRets, ihEq[ihEq.length - 1], rfPeriod, null);

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
      ...rfWindowStats(rfAt, rf, rebalanceWeeks[0], rebalanceWeeks[rebalanceWeeks.length - 1]),
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

/**
 * r_f summary for the results window. DISPLAY ONLY — the walk scores each step at its own
 * dated rate; this is the single number shown in the UI's r_f stat, plus the range so a
 * policy move inside the window is visible rather than averaged away silently.
 */
function rfWindowStats(rfAt, rf, startISO, endISO) {
  if (!rfAt || rfAt.mode !== 'series' || !startISO || !endISO) {
    return { riskFreeRate: rf, riskFreeRateMode: 'constant' };
  }
  const inWindow = [rfAt(startISO), rfAt(endISO), ...rfAt.history.filter(r => r.effective > startISO && r.effective < endISO).map(r => r.rate)];
  return {
    riskFreeRate: meanRateOver(rfAt.history, startISO, endISO) ?? rf,
    riskFreeRateMode: 'series',
    riskFreeRateRange: { min: Math.min(...inWindow), max: Math.max(...inWindow) },
  };
}

/**
 * Rebalance grid for a frequency, ANCHORED AT THE NEWEST BAR.
 *
 * The grid used to be `rows.filter((_, i) => i % step === 0)` — anchored at index 0 and
 * stepping forward. That silently discarded every bar after the last grid point: up to
 * `step - 1` weeks (12 for quarterly), and the amount cycled 0→12 as new bars arrived, so
 * the reported window could sit almost three months behind data the app had already loaded.
 *
 * Anchoring at the end instead makes the last rebalance the most recent bar, always. Steps
 * remain exactly `step` weeks apart, so per-period annualisation is unchanged; what shifts
 * is the *start*, which now begins up to `step - 1` bars into the available history rather
 * than at bar 0. That ragged prefix is dropped rather than kept as a short first interval,
 * which would distort the first period's return.
 *
 * No look-ahead is introduced: each step's context is still built only from data at or
 * before its own date (see buildStepContexts).
 *
 * The trade-off, stated plainly: the whole grid now shifts by one bar each time a new bar
 * lands, so re-running next week moves every rebalance date and the numbers move with it.
 * Previously they were frozen for `step` weeks and then jumped. For a research tool that
 * is the better default — a window that silently trails the data by up to three months is
 * the more misleading failure — but two runs a week apart are not directly comparable.
 *
 * "Newest bar" means the newest week EVERY included name has a price for (the aligned
 * intersection), not the newest bar any one ticker has; you cannot rebalance into a week
 * where a holding is unpriced.
 */
function rebalanceGrid(rows, step) {
  if (step <= 1) return rows;
  const offset = (rows.length - 1) % step; // drop the ragged prefix, keep the newest bar
  return rows.filter((_, i) => i >= offset && (i - offset) % step === 0);
}

/**
 * Sample-mean expected returns — the "no prior" μ, i.e. textbook Markowitz mean-variance.
 *
 * The three BL prior modes ('cap' / 'shrunk' / 'equal') never estimate μ from returns at all:
 * they reverse-optimize it out of reference weights (π = r_f + δΣw). This is the alternative
 * the equilibrium prior exists to avoid — estimate μ directly from the trailing window and
 * let the optimizer do what it likes with it.
 *
 * Same information set as Σ: it reads `meta.dailyReturns`, the identical trailing-252-day
 * slice (all dates ≤ t) that buildStepContexts already cut for the vol estimate, so no new
 * look-ahead is introduced and the mean and the covariance always describe the same window.
 *
 * UNITS — the one place this is easy to get wrong. `dailyReturns` are LOG returns
 * (dailyLogReturns), while every consumer of μ downstream wants an ANNUAL SIMPLE total
 * return: the Sharpe objective subtracts r_f from wᵀμ, and robustObjective's realization
 * path converts back with ln(1+μ) − Σᵢᵢ/2 (Ito). So invert exactly that:
 *
 *   m   = mean(daily log returns) × 252        annualized log drift
 *   μᵢ  = exp(m + Σᵢᵢ/2) − 1                 annual simple total return
 *
 * using the same shrunk annual variance Σᵢᵢ the objective itself uses. Skipping the
 * ½σ² term would systematically understate μ on the most volatile names — by ~2.6%/yr at
 * a 23% annual vol — which is a silent tilt against exactly the names Σ already penalizes.
 *
 * The mean is EQUAL-weighted over the window even though the vol is theta-decayed. That is
 * deliberate: a sample mean is already the noisiest input in the problem (its standard error
 * falls only as √T), and decay-weighting it would cut the effective sample further. This is
 * the textbook estimator, which is the point of the option.
 *
 * Names with too little history fall back to r_f — zero expected excess return, so the
 * optimizer simply declines to hold them, rather than a 0 that would read as a real
 * negative view once r_f is subtracted.
 *
 * @param {{meta:{dailyReturns:number[]}}[]} volAssets  per-asset trailing daily LOG returns
 * @param {number[][]} covMatrix  annualized covariance (post-shrinkage)
 * @param {number} rfStep  r_f in effect at this rebalance date
 * @returns {number[]} annual simple total returns, one per asset
 */
function sampleMeanReturns(volAssets, covMatrix, rfStep) {
  return volAssets.map((a, i) => {
    const r = a.meta.dailyReturns;
    if (!r || r.length < MIN_SAMPLE_MEAN_OBS) return rfStep;
    const mLog = r.reduce((s, v) => s + v, 0) / r.length * TRADING_DAYS;
    const varAnn = Math.max(covMatrix[i][i], 0);
    return Math.exp(mLog + varAnn / 2) - 1;
  });
}

/**
 * Point-in-time flavour of buildRiskContexts: at each rebalance, Σ / vol / prior are built
 * over ONLY the names that were in the index on that date (newest snapshot dated <= t) and
 * had a full correlation window of history — never over today's members.
 *
 * Why this exists: pre-selecting today's index members hands the optimizer a set filtered
 * on outcomes (a name is in LQ45 now because it grew). Measured on this repo's LQ45 tier
 * that was worth ~0.68 of Sharpe. See portfolio-app/data/index-members.js.
 *
 * Shape: the run keeps ONE full universe U (every name that was ever a member in the
 * window). Each step optimizes on the subset `idx` ⊂ U and carries FULL-length rVec/advVec
 * (zero outside the subset) so drift and costs stay index-aligned across steps. Names that
 * enter the index are bought at the step they qualify; names that leave are sold — both
 * charged through the ordinary drift-adjusted turnover cost.
 *
 * Eligibility = member(t) AND first weekly bar <= t − 365d (the same full-window rule the
 * fixed-universe walk applies to its newest listing) AND a positive price at t. The
 * 365d rule withholds a fresh IPO for its first year even if the index already holds it —
 * conservative, never look-ahead. Counts are returned in `pitStats` so the drop is visible.
 */
function buildRiskContextsPIT(grid, ctx) {
  const { corrAssets, dailyRet, dailyDV, included, hasLiquidity, volHalfLife,
    benchByKey, rf, rfAt, useSectors = false, pit } = ctx;
  const rateOn = rfAt ?? (() => rf);
  const N = included.length;
  const slot = new Map(included.map((a, k) => [a.ticker, k]));
  const firstBar = included.map(a => a.weekly?.dates?.[0] ?? '9999-12-31');
  const risk = [];
  let lookAhead = null;
  const stats = { steps: 0, memberSteps: 0, eligibleSteps: 0, noHistory: 0, noPrice: 0,
    notInHistory: 0, minEligible: Infinity, maxEligible: 0, noHistoryByTicker: {},
    // Index weight (%, summed over steps) the archive says was in the index vs the part of it
    // the run could NOT hold. Yahoo keeps no bars for delisted/suspended names (SRIL, WSKT,
    // TRAM…), so the worst collapses are missing — droppedWeight/totalWeight is the size of
    // the survivorship that remains, and it errs OPTIMISTIC.
    totalWeight: 0, droppedWeight: 0 };

  for (let i = 0; i < grid.length - 1; i++) {
    const row = grid[i], rowNext = grid[i + 1];
    const t = row.date, tNext = rowNext.date;
    const startISO = addCalendarDays(t, -CORR_WINDOW_DAYS);
    const dailyCutoff = addCalendarDays(t, 4);
    const histCutoff = addCalendarDays(t, -CORR_WINDOW_DAYS);

    const snap = snapshotAsOf(pit.membership, t);
    if (!snap) throw new Error(`No index-membership snapshot on or before ${t} — start the window later.`);
    const idx = [], memberRows = [];
    for (const m of snap.members) {
      stats.memberSteps++;
      stats.totalWeight += m.weight ?? 0;
      const k = slot.get(m.ticker);
      if (k == null) { stats.notInHistory++; stats.droppedWeight += m.weight ?? 0; continue; }
      if (firstBar[k] > histCutoff) {
        stats.noHistory++;
        stats.droppedWeight += m.weight ?? 0;
        stats.noHistoryByTicker[m.ticker] = (stats.noHistoryByTicker[m.ticker] ?? 0) + 1;
        continue;
      }
      if (!(row[m.ticker] > 0)) { stats.noPrice++; stats.droppedWeight += m.weight ?? 0; continue; }
      idx.push(k); memberRows.push(m);
    }
    stats.steps++;
    stats.eligibleSteps += idx.length;
    stats.minEligible = Math.min(stats.minEligible, idx.length);
    stats.maxEligible = Math.max(stats.maxEligible, idx.length);
    if (idx.length < 2) throw new Error(`Only ${idx.length} eligible index member(s) at ${t}.`);

    const subCorr = idx.map(k => corrAssets[k]);
    const { matrix, obs } = computeCorrelationFromDateRange(subCorr, startISO, t);
    const volAssets = idx.map(k => {
      const end = idxAtOrBefore(dailyRet[k].dates, dailyCutoff);
      const lo = Math.max(0, end + 1 - 252);
      const slice = end >= 0 ? dailyRet[k].vals.slice(lo, end + 1) : [];
      if (end >= 0 && dailyRet[k].dates[end] >= tNext && !lookAhead) {
        lookAhead = `${dailyRet[k].dates[end]} >= next ${tNext}`;
      }
      const a = included[k];
      const sector = useSectors ? (SECTOR_MAP[a.ticker] ?? 'Other') : 'ALL';
      return { ticker: a.ticker, sector, meta: { dailyReturns: slice } };
    });
    const { covMatrix } = computeCovarianceMatrix(matrix, volAssets, { volHalfLife, shrinkage: true, nObs: obs });

    const rfStep = rateOn(t);

    // FULL-length realized returns / ADV: zero outside the step's subset.
    const rVec = new Array(N).fill(0);
    const advVec = hasLiquidity ? new Array(N).fill(0) : null;
    for (const k of idx) {
      const tk = included[k].ticker;
      const p0 = row[tk], p1 = rowNext[tk];
      rVec[k] = p0 > 0 && p1 != null ? p1 / p0 - 1 : 0;
      if (hasLiquidity) {
        const end = idxAtOrBefore(dailyDV[k].dates, dailyCutoff);
        if (end >= 0) {
          const lo = Math.max(0, end + 1 - COST.advWindow);
          const win = dailyDV[k].dv.slice(lo, end + 1);
          advVec[k] = win.length ? win.reduce((acc, v) => acc + v, 0) / win.length : 0;
        }
      }
    }
    const b0 = benchByKey.get(t), b1 = benchByKey.get(tNext);
    const ihsgRet = b0 > 0 && b1 != null ? b1 / b0 - 1 : 0;

    // The index's own dated weights over the eligible names — the honest "just buy the
    // index" baseline, and (via shares) the dated cap-prior input.
    const wSum = memberRows.reduce((acc, m) => acc + (m.weight > 0 ? m.weight : 0), 0);
    const indexW = new Array(N).fill(0);
    memberRows.forEach((m, j) => { indexW[idx[j]] = wSum > 0 ? Math.max(m.weight, 0) / wSum : 1 / idx.length; });

    risk.push({
      t, tNext, covMatrix, volAssets, rVec, advVec, ihsgRet, rf: rfStep,
      px: idx.map(k => row[included[k].ticker]),
      // ── PIT extras (read by attachMu / the walkers / the baselines) ──
      idx, indexW,
      included: idx.map(k => included[k]),
      sharesOut: memberRows.map(m => (m.shares > 0 ? m.shares : 0)),   // DATED shares (millions)
    });
  }
  if (!Number.isFinite(stats.minEligible)) stats.minEligible = 0;
  return { risk, lookAhead, pitStats: stats };
}

/**
 * Build the EXPENSIVE, μ-INDEPENDENT half of each step: Σ, the vol assets, realized
 * returns, ADV and r_f. Nothing here depends on priorMode / viewMode / factorConfig, so
 * one build is reusable across every μ configuration over the same (universe, frequency,
 * volHalfLife, window).
 *
 * That reuse is the point: the covariance construction costs ~34 ms/step against ~4-5 ms
 * for one optimizer walk, so a config sweep that rebuilt Σ per config would spend roughly
 * half its time recomputing an identical matrix. See scripts/sweep-configs.mjs.
 *
 * `px` (the per-asset price at t) is carried so the cap-weight prior can be formed later
 * without re-reading the grid.
 */
export function buildRiskContexts(grid, ctx) {
  if (ctx.pit) return buildRiskContextsPIT(grid, ctx);
  const { corrAssets, dailyRet, dailyDV, included, hasLiquidity, volHalfLife,
    benchByKey, rf, rfAt, useSectors = false } = ctx;
  // Fall back to the flat rate when no lookup was supplied (direct callers / older tests).
  const rateOn = rfAt ?? (() => rf);
  const risk = [];
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

    // r_f as of THIS rebalance date, not as of today.
    const rfStep = rateOn(t);

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
    risk.push({ t, tNext, covMatrix, volAssets, rVec, advVec, ihsgRet, rf: rfStep,
      px: included.map(a => row[a.ticker]) });
  }
  return { risk, lookAhead };
}

/**
 * Attach μ to prebuilt risk contexts. CHEAP — this is the half that varies per config,
 * and the only half a config sweep needs to redo. Pure: returns new context objects and
 * never mutates the risk array it is given, so one risk build feeds many configs.
 */
export function attachMu(risk, ctx) {
  const { included, sharesOut, capMode, priorMode = 'cap',
    viewMode = 'off', viewLookup = null, factorConfig = null } = ctx;
  if (!PRIOR_MODES.includes(priorMode)) {
    throw new Error(`Unknown priorMode "${priorMode}" (expected ${PRIOR_MODES.join(' | ')}).`);
  }
  if (!VIEW_MODES.includes(viewMode)) {
    throw new Error(`Unknown viewMode "${viewMode}" (expected ${VIEW_MODES.join(' | ')}).`);
  }
  // A view mode that needs the archive but has no lookup would silently degrade to the
  // sample-mean fallback on every name — i.e. report itself as view-driven while using
  // no views at all. Fail loudly instead.
  if ((viewMode === 'analyst' || viewMode === 'hybrid') && !viewLookup) {
    throw new Error(`viewMode "${viewMode}" needs an analyst-view archive — pass opts.views (see loadAnalystViews).`);
  }
  const contexts = [];
  let viewCells = 0, viewCovered = 0;   // ticker-steps offered vs actually served by a target
  for (const step of risk) {
    const { t, covMatrix, volAssets, px: pxAt } = step;   // pxAt = price per asset at t
    const rfStep = step.rf;
    // Point-in-time membership runs carry their OWN asset set (and dated shares) per step:
    // the names in the index and eligible at t. Fixed-universe runs fall through to the
    // run-wide `included` / `sharesOut`, so their behaviour is unchanged.
    const inc = step.included ?? included;
    const sh = step.sharesOut ?? sharesOut;
    const n = inc.length;

    // ── μ assembly ──────────────────────────────────────────────────────────────
    // Two independent axes that compose:
    //
    //   priorMode (ANCHOR)  'cap' | 'shrunk' | 'equal' → the Black-Litterman equilibrium
    //     π = r_f + δ·Σ·w_prior, reverse-optimized from reference weights. 'none' → no anchor.
    //   viewMode (SIGNAL)   where each name's expected return comes from. See VIEW_MODES.
    //
    // With an anchor, the signal enters as BL views Q and the optimizer sees the posterior.
    // Without one, the signal IS μ. viewMode 'off' + any priorMode reproduces the historical
    // behavior exactly: no view vector is built and π (or the sample mean) is used directly.
    //
    // NOTE ON THE π-ONLY PATH: max-Sharpe on π alone returns the prior weights identically
    // (w ∝ Σ⁻¹(π − r_f·1) = Σ⁻¹δΣw_prior ∝ w_prior), so with viewMode 'off' the Max-Sharpe
    // variant is the cap-weighted book by construction. A signal is what breaks that identity.

    // Equilibrium-prior reference weights w_prior. capMode='equal' (shares unreliable) forces
    // equal regardless of priorMode. Otherwise priorMode picks: 'cap' = market-cap (sharesOut ×
    // price(t)), 'equal' = 1/n, 'shrunk' = 50/50 blend (both inputs sum to 1 → blend does too).
    let pi = null;
    if (priorMode !== 'none') {
      const equalW = Array(n).fill(1 / n);
      let capW;
      if (capMode !== 'cap' || priorMode === 'equal') {
        capW = equalW;
      } else {
        const caps = inc.map((a, k) => {
          const p = pxAt[k];
          return p > 0 && sh[k] > 0 ? p * sh[k] : 0;
        });
        const s = caps.reduce((acc, v) => acc + v, 0);
        const capRaw = s > 0 ? caps.map(v => v / s) : equalW;
        capW = priorMode === 'shrunk' ? capRaw.map((v, k) => 0.5 * v + 0.5 * equalW[k]) : capRaw;
      }
      const delta = defaultDelta(covMatrix, capW, rfStep);
      // computeEquilibriumReturns returns TOTAL returns (π = r_f + δ·Σ·w) — the space the shared
      // Sharpe objective expects (it subtracts r_f itself). Since the book is fully invested
      // (Σw=1), wᵀπ − r_f = wᵀ(δΣw), the true tangency numerator. Without the r_f gross-up in π,
      // the −r_f/σ term would reward variance → Max-Sharpe/Tail blow out into concentrated,
      // high-turnover portfolios.
      pi = computeEquilibriumReturns(covMatrix, capW, { riskFreeRate: rfStep, delta });
    }

    // The trailing sample mean is computed at most once per step, and only if a mode needs it.
    let sampleMu = null;
    const sampleAt = () => (sampleMu ??= sampleMeanReturns(volAssets, covMatrix, rfStep));

    let muEq;
    let stepViews = 0;              // names carrying a REAL analyst view at this step
    if (viewMode === 'off') {
      muEq = pi ?? sampleAt();
    } else {
      // Q, plus which names carry a view at all (ω → ∞ for the rest, i.e. "no opinion").
      const Q = new Array(n);
      const hasView = new Array(n).fill(false);
      const viewMeta = new Array(n).fill(null);

      if (viewMode !== 'sample' && viewLookup) {
        for (let k = 0; k < n; k++) {
          // As-of lookup: the newest target dated ON OR BEFORE this rebalance. Never after.
          const v = viewLookup(inc[k].ticker, t);
          if (!v) continue;
          Q[k] = v.totalReturn;     // 12-month TOTAL return — same space as π
          hasView[k] = true;
          viewMeta[k] = v;
          stepViews++;
        }
      }
      for (let k = 0; k < n; k++) {
        if (hasView[k]) continue;
        if (viewMode === 'hybrid' || viewMode === 'sample') {
          Q[k] = sampleAt()[k];     // ← the fallback: trailing 1-year mean stands in for a target
          hasView[k] = true;
        } else {
          Q[k] = pi ? pi[k] : sampleAt()[k];   // 'analyst': untilted, left at the anchor
        }
      }

      if (!pi) {
        muEq = Q;                   // no anchor — the signal is μ outright
      } else {
        // Ω from the archive's dated dispersion + analyst coverage. computeViewUncertainty
        // reads forwardEstimates, so rebuild the minimal shape it needs: dispersion d is
        // reproduced exactly by low/mean/high = (1 − d/2, 1, 1 + d/2).
        const omegaAssets = inc.map((a, k) => {
          const d = viewMeta[k]?.dispersion ?? 0;
          return {
            forwardEstimates: {
              meanTarget: 1, lowTarget: 1 - d / 2, highTarget: 1 + d / 2,
              totalAnalysts: viewMeta[k]?.analysts ?? SAMPLE_VIEW_ANALYSTS,
            },
          };
        });
        const maxAnalysts = Math.max(1, ...omegaAssets.map(x => x.forwardEstimates.totalAnalysts));
        const omega = computeViewUncertainty(omegaAssets, covMatrix, factorConfig, maxAnalysts);
        for (let k = 0; k < n; k++) if (!hasView[k]) omega[k] = 1e12; // no view ⇒ ignored
        muEq = blackLittermanPosterior({
          pi, Q, omega, covMatrix, tau: factorConfig?.tau ?? 0.03,
        });
      }
    }
    viewCells += n;
    viewCovered += stepViews;

    contexts.push({ ...step, muEq });
  }
  // Coverage is reported, never assumed: a run must not read as "analyst-driven" when the
  // archive only reached a fraction of its ticker-steps.
  const viewCoverage = { mode: viewMode, cells: viewCells, covered: viewCovered,
    coverage: viewCells ? viewCovered / viewCells : 0 };
  return { contexts, viewCoverage };
}

/**
 * Build per-step context (Σ, μ, realized returns, ADV) once for a rebalance grid.
 * Thin composition of the two halves above; pass `ctx.riskContexts` to reuse a prior build.
 */
function buildStepContexts(grid, ctx) {
  const built = ctx.riskContexts
    ? { risk: ctx.riskContexts, lookAhead: ctx.riskLookAhead ?? null }
    : buildRiskContexts(grid, ctx);
  const { contexts, viewCoverage } = attachMu(built.risk, ctx);
  return { contexts, lookAhead: built.lookAhead, viewCoverage };
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
    const wDrift = kappa > 0 && i > 0 ? driftOnStepSet(weights[i - 1], contexts[i - 1], c) : null;
    weights.push(embedStep(minVarTurnoverPenalized(c.covMatrix, c.volAssets, wDrift, kappa, constraints), c));
  }
  return weights;
}

// ── point-in-time membership: weights live on a per-step SUBSET ───────────────
// A PIT context optimizes over only the names in the index (and eligible) at that step, so
// covMatrix / volAssets / muEq are subset-sized, while everything downstream — drift, cost,
// turnover — works on FULL-universe vectors (rVec / advVec are full-length, zero for names
// that are out). These two helpers are the only bridge between the two. Contexts without an
// `idx` (fixed universe) pass through untouched.

/** Subset-sized weights → full-universe vector, zero for every name outside the step. */
function embedStep(wSub, c) {
  if (!c.idx) return wSub;
  const out = new Array(c.rVec.length).fill(0);
  c.idx.forEach((i, k) => { out[i] = wSub[k]; });
  return out;
}

/**
 * Last step's FULL weights, drifted by that step's realized returns, then restricted to the
 * names this step may hold and renormalized — the "where am I now" vector the turnover
 * penalty pulls toward. A name that fell out of the index simply drops out of it; the cost
 * of selling it is charged separately, on the full vectors, by buildCostedSeries.
 */
function driftOnStepSet(wPrevFull, cPrev, c) {
  const drifted = driftWeights(wPrevFull, cPrev.rVec);
  if (!c.idx) return drifted;
  const sub = c.idx.map(i => drifted[i]);
  const s = sub.reduce((a, v) => a + v, 0);
  return s > 1e-12 ? sub.map(v => v / s) : null;
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
    const currentWeights = kappa > 0 && i > 0 ? driftOnStepSet(weights[i - 1], contexts[i - 1], c) : null;
    const rng = seed != null ? makeRng((seed + i) >>> 0) : Math.random;
    const { weights: w } = optimizeTailAware(scenarios, c.covMatrix, c.volAssets, {
      // Step's own r_f (set by buildStepContexts); falls back to the flat rate.
      sectorCaps: constraints.sectorCaps, maxPositionCap: constraints.maxPositionCap, riskFreeRate: c.rf ?? rf,
      robustMode: mode, tailPenalty, turnoverPenalty: kappa, currentWeights,
      deterministicStarts: true, optimizeMaxIter, rng,
    });
    weights.push(embedStep(w, c));
  }
  return weights;
}

/** Cost the realized path of a weight sequence over its grid. */
function costStrategy(weights, contexts, hasLiquidity, rfPeriod, benchRets, ppy) {
  const grossRets = weights.map((w, i) => w.reduce((s, wk, k) => s + wk * contexts[i].rVec[k], 0));
  const rByStep = contexts.map(c => c.rVec);
  const advByStep = hasLiquidity ? contexts.map(c => c.advVec) : null;
  return buildCostedSeries(grossRets, weights, rByStep, advByStep, rfPeriod, benchRets, ppy);
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
function prepareStrategyInputs(data, includedTickers, volHalfLife, windowStart = DEFAULT_WINDOW_START) {
  const rf = data.riskFreeRate ?? BI_RATE_FALLBACK;
  // Dated r_f: each rebalance is scored at the policy rate in effect ON that date, so a
  // 2013 step never sees a rate BI had not set yet. Absent a series this collapses to the
  // scalar, reproducing prior results exactly.
  const rfAt = makeRateLookup(data.riskFreeRateSeries, rf);
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
  // Whichever binds later: enough history for the correlation window, or the instrument floor.
  const listingBound = addCalendarDays(newestListing, CORR_WINDOW_DAYS);
  const backtestStart = laterISO(listingBound, windowStart);
  const boundBy = windowStart && backtestStart === windowStart && windowStart > listingBound ? 'windowStart' : 'listing';
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
  // Surface a short r_f series rather than burying it: rateAsOf flat-extends backwards, so
  // steps before the first captured decision are scored at the oldest known rate.
  const firstStep = rebalanceRows[0].date;
  const oldestDecision = rfAt.history[0]?.effective;
  if (rfAt.mode === 'series' && oldestDecision && oldestDecision > firstStep) {
    warnings.push(`r_f series starts ${oldestDecision}; steps from ${firstStep} use the oldest known rate (${(rfAt.history[0].rate * 100).toFixed(2)}%).`);
  } else if (rfAt.mode === 'constant') {
    warnings.push(`r_f is a single constant ${(rf * 100).toFixed(2)}% across the whole window (no dated series available).`);
  }

  const corrAssets = included.map(a => ({ ticker: a.ticker, priceHistory: a.weekly }));
  const sharedCtx = { corrAssets, dailyRet, dailyDV, included, hasLiquidity, volHalfLife, benchByKey, sharesOut, capMode, rf, rfAt };
  return { ok: true, rf, rfAt, warnings, included, hasLiquidity, capMode, rebalanceRows, newestListing, windowStart: windowStart ?? null, boundBy, sharedCtx };
}

/**
 * Every name in the history file that was an index member at any point from `windowStart`
 * on — the FULL universe of a point-in-time run. Per-step membership then decides who is
 * actually tradable when. Exported so a sweep can print and fingerprint it.
 */
export function pitUniverse(data, membership, windowStart = DEFAULT_WINDOW_START) {
  const known = new Set(data.tickers.map(t => t.ticker));
  // The snapshot in force AT windowStart is dated on or before it — reach back a little
  // further than a month so that first snapshot is always included.
  const from = windowStart ? addCalendarDays(windowStart, -35) : (membership.dates?.[0] ?? '0000-00-00');
  const out = new Set();
  for (const snap of membership.snapshots ?? []) {
    if (snap.date < from) continue;
    for (const m of snap.members) if (known.has(m.ticker)) out.add(m.ticker);
  }
  return [...out];
}

/**
 * prepareStrategyInputs' point-in-time sibling. Same return shape, so runStrategyBacktest
 * needs no second code path for the walk itself — only for what the universe IS at a step.
 *
 * The difference that matters: the fixed-universe path INNER-JOINS every name's weekly
 * history to build the rebalance calendar, which caps the walk at the newest listing. A
 * point-in-time universe is by construction full of late listings and early exits, so the
 * calendar comes from the IHSG bars instead and every row carries whichever prices exist.
 * Who is tradable at a row is then decided per step by buildRiskContextsPIT.
 */
function preparePITInputs(data, membership, volHalfLife, windowStart = DEFAULT_WINDOW_START) {
  const rf = data.riskFreeRate ?? BI_RATE_FALLBACK;
  const rfAt = makeRateLookup(data.riskFreeRateSeries, rf);
  const warnings = [];
  const byTicker = new Map(data.tickers.map(t => [t.ticker, t]));
  const universe = pitUniverse(data, membership, windowStart);
  const included = universe.map(t => byTicker.get(t));
  if (included.length < 2) return { ok: false, warnings: ['Membership archive yields fewer than 2 priced names.'] };

  const dailyRet = included.map(a => dailyLogReturns(a.daily));
  const dailyDV = included.map(a => ({ dates: a.daily.dates, dv: a.daily.dollarVol ?? null }));
  const hasLiquidity = dailyDV.every(x => Array.isArray(x.dv) && x.dv.length === x.dates.length);
  if (!hasLiquidity) warnings.push('No dollar-volume for some names — using flat per-side transaction cost.');
  const sharesOut = included.map(a => (Number.isFinite(a.sharesOut) && a.sharesOut > 0 ? a.sharesOut : 0));

  // Canonical weekly price per name (latest source bar wins — same rule as alignPriceSeries).
  const px = included.map(a => {
    const m = new Map();
    const src = new Map();
    const ds = a.weekly?.dates ?? [], ps = a.weekly?.adjClose ?? [];
    for (let i = 0; i < ds.length; i++) {
      if (ps[i] == null) continue;
      const key = canonicalWeeklyKey(ds[i]);
      if (!src.has(key) || ds[i] > src.get(key)) { src.set(key, ds[i]); m.set(key, ps[i]); }
    }
    return m;
  });

  const benchByKey = new Map();
  data.benchmark.weekly.dates.forEach((d, i) => {
    const p = data.benchmark.weekly.adjClose[i];
    if (p != null) benchByKey.set(canonicalWeeklyKey(d), p);
  });

  const firstSnap = membership.dates?.[0];
  const floor = windowStart ?? (firstSnap ? addCalendarDays(firstSnap, CORR_WINDOW_DAYS) : '0000-00-00');
  const calendar = [...benchByKey.keys()].sort().filter(d => d >= floor);
  let rows = calendar.map(date => {
    const row = { date };
    included.forEach((a, k) => { const v = px[k].get(date); if (v != null) row[a.ticker] = v; });
    return row;
  });
  // Trim a ragged tail: a final bar the vendor has only partly published would score most
  // of the book at a zero return.
  const snapEnd = snapshotAsOf(membership, rows[rows.length - 1]?.date ?? '9999');
  const nowMembers = new Set((snapEnd?.members ?? []).map(m => m.ticker));
  const memberPriced = row => [...nowMembers].reduce((c, t) => c + (row[t] > 0 ? 1 : 0), 0);
  while (rows.length && nowMembers.size && memberPriced(rows[rows.length - 1]) < 0.9 * nowMembers.size) rows.pop();
  if (rows.length < 12) {
    return { ok: false, warnings: [`Only ${rows.length} weekly bars from ${floor} — window too short for a strategy backtest.`] };
  }

  const firstStep = rows[0].date;
  const oldestDecision = rfAt.history[0]?.effective;
  if (rfAt.mode === 'series' && oldestDecision && oldestDecision > firstStep) {
    warnings.push(`r_f series starts ${oldestDecision}; steps from ${firstStep} use the oldest known rate (${(rfAt.history[0].rate * 100).toFixed(2)}%).`);
  } else if (rfAt.mode === 'constant') {
    warnings.push(`r_f is a single constant ${(rf * 100).toFixed(2)}% across the whole window (no dated series available).`);
  }

  const corrAssets = included.map(a => ({ ticker: a.ticker, priceHistory: a.weekly }));
  const sharedCtx = { corrAssets, dailyRet, dailyDV, included, hasLiquidity, volHalfLife, benchByKey,
    sharesOut, capMode: 'cap', rf, rfAt, pit: { membership } };
  return { ok: true, rf, rfAt, warnings, included, hasLiquidity, capMode: 'cap', rebalanceRows: rows,
    newestListing: null, windowStart: windowStart ?? null, boundBy: 'membership', sharedCtx };
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
    priorMode = 'cap',              // ANCHOR: BL-equilibrium prior weights 'cap' | 'shrunk' |
                                    // 'equal', or 'none' = no prior at all
    viewMode = 'off',               // SIGNAL: 'off' | 'analyst' | 'hybrid' | 'sample' (VIEW_MODES)
    views = null,                   // parsed analyst-views.json; required by 'analyst'/'hybrid'
    factorConfig = null,            // BL knobs: { tau, omegaScale, analystConfidence, dispersionOmega }
    maxStalenessDays = DEFAULT_MAX_STALENESS_DAYS, // older target ⇒ treated as no view
    windowStart = DEFAULT_WINDOW_START, // earliest walk-forward step; null ⇒ listing-bound only
    membership = null,              // parsed index-members.json ⇒ POINT-IN-TIME universe: each step
                                    // optimizes only over names in the index (and eligible) at t,
                                    // with dated shares for the cap prior. `includedTickers` is
                                    // ignored — the universe is derived from the archive
                                    // (see pitUniverse). null ⇒ the fixed-universe walk.
    riskCache = null,               // optional Map(freqKey → {risk, lookAhead}) shared ACROSS runs.
                                    // Σ construction is ~34 ms/step vs ~4-5 ms for one optimizer
                                    // walk, so a config sweep that rebuilt it per config would burn
                                    // roughly half its time on an identical matrix. ONLY valid while
                                    // (universe, volHalfLife, windowStart, data) are held fixed —
                                    // the caller owns the Map and must drop it when any of those move.
  } = opts;

  // One lookup bound for the whole run — pure, and shared across every frequency.
  const viewLookup = views ? makeViewLookup(views, { maxStalenessDays }) : null;
  const stepOpts = { priorMode, viewMode, viewLookup, factorConfig };

  const prep = membership
    ? preparePITInputs(data, membership, volHalfLife, windowStart)
    : prepareStrategyInputs(data, includedTickers, volHalfLife, windowStart);
  if (!prep.ok) return { ok: false, warnings: prep.warnings };
  const { rf, rfAt, warnings, included, hasLiquidity, capMode, rebalanceRows, newestListing, windowStart: appliedWindowStart, boundBy, sharedCtx } = prep;
  let pitStats = null;

  // ── Ω-input provenance guard ────────────────────────────────────────────────
  // Q needs only (target, price) — both fully dated. Ω does NOT: its coverage and
  // dispersion terms read analyst COUNT and target SPREAD, which the vendor target export
  // does not carry. Those come from the weekly capture archive, which only begins in 2026,
  // so before its first row Ω is extrapolated from a CONSTANT present-day value at every
  // historical step. That is 2026 information entering a 2018 Ω.
  //
  // It cannot leak returns directly, but it is not neutral either: a name that attracted
  // more analysts BECAUSE it did well gets a tighter ω — more trust in its view — across
  // the entire backtest. Measured on the reference universe, switching the coverage term
  // off (analystConfidence: 0) LOWERS full-window Sharpe but RAISES the held-out test
  // slice at both quarterly and monthly, which is the signature of exactly that tilt.
  //
  // Only warn when the term is actually switched on and the archive genuinely cannot cover
  // the window — a fully-covered future run should stay silent.
  if (viewMode !== 'off' && priorMode !== 'none' && views) {
    const conf = factorConfig?.analystConfidence ?? 0.7;
    const disp = factorConfig?.dispersionOmega ?? 0.8;
    if (conf > 0 || disp > 0) {
      let earliestEnrich = null;
      for (const rec of Object.values(views.tickers ?? {})) {
        const d = rec.enrich?.[0]?.d;
        if (d && (!earliestEnrich || d < earliestEnrich)) earliestEnrich = d;
      }
      const firstStep = rebalanceRows[0]?.date;
      if (firstStep && (!earliestEnrich || earliestEnrich > firstStep)) {
        warnings.push(
          `Ω provenance: analyst coverage/dispersion are constant-extrapolated from ${earliestEnrich ?? 'the present snapshot'} `
          + `back to ${firstStep} — present-day values applied at historical steps. Q itself is fully dated and unaffected. `
          + `Set analystConfidence:0 (and dispersionOmega:0) to remove the extrapolated terms from Ω.`);
      }
    }
  }

  const byFrequency = {};
  let lookAheadAny = null;
  const viewCoverageByFreq = {};
  const round2 = arr => arr.map(v => +v.toFixed(2));

  for (const freqKey of frequencies) {
    const freq = FREQUENCIES[freqKey];
    if (!freq) continue;
    const grid = rebalanceGrid(rebalanceRows, freq.step);
    if (grid.length < 6) { warnings.push(`${freqKey}: too few rebalances (${grid.length}).`); continue; }
    const ppy = freq.periodsPerYear;

    let cachedRisk = riskCache?.get(freqKey) ?? null;
    if (!cachedRisk) {
      cachedRisk = buildRiskContexts(grid, sharedCtx);
      riskCache?.set(freqKey, cachedRisk);
    }
    if (cachedRisk.pitStats) (pitStats ??= {})[freqKey] = cachedRisk.pitStats;
    const { contexts, lookAhead, viewCoverage } = buildStepContexts(grid, {
      ...sharedCtx, ...stepOpts, riskContexts: cachedRisk.risk, riskLookAhead: cachedRisk.lookAhead,
    });
    if (lookAhead && !lookAheadAny) lookAheadAny = lookAhead;
    if (viewCoverage) viewCoverageByFreq[freqKey] = viewCoverage;
    const benchRets = contexts.map(c => c.ihsgRet);
    const dates = [...contexts.map(c => c.t), grid[grid.length - 1].date];

    // Per-period r_f for this grid: each context already carries the rate in effect at
    // its own rebalance date, so the Sharpe excess series and the optimizer that produced
    // the weights are charged the SAME rate.
    const rfPeriod = contexts.map(c => perPeriodRate(c.rf ?? rf, ppy));

    // Baselines on this grid.
    const mvW = walkMinVar(contexts);
    // Equal-weight over whoever is tradable at the step (the whole fixed universe otherwise).
    const ewW = contexts.map(c => (c.idx
      ? embedStep(Array(c.idx.length).fill(1 / c.idx.length), c)
      : Array(included.length).fill(1 / included.length)));
    const costMV = costStrategy(mvW, contexts, hasLiquidity, rfPeriod, benchRets, ppy);
    const costEW = costStrategy(ewW, contexts, hasLiquidity, rfPeriod, benchRets, ppy);
    // Point-in-time only: the index's own dated weights — the fair "just buy LQ45" yardstick.
    const costIW = contexts[0]?.indexW
      ? costStrategy(contexts.map(c => c.indexW), contexts, hasLiquidity, rfPeriod, benchRets, ppy)
      : null;
    const ihEq = cumEquity(benchRets);
    const ihMetrics = seriesMetrics(benchRets, ihEq[ihEq.length - 1], rfPeriod, null, ppy);

    // Tail-objective variants (Max-Sharpe + tail-λ levels) at the fixed κ.
    const curves = {};
    const metrics = {};
    for (const v of variants) {
      const w = walkVariant(contexts, { mode: v.mode, tailPenalty: v.tailPenalty, kappa, paths, optimizeMaxIter, rf, seed });
      const costed = costStrategy(w, contexts, hasLiquidity, rfPeriod, benchRets, ppy);
      curves[v.key] = { grossEq: round2(costed.grossEq), netEq: round2(costed.netEq) };
      metrics[v.key] = packNet(costed);
    }
    curves.MinVar = { grossEq: round2(costMV.grossEq), netEq: round2(costMV.netEq) };
    curves.EqualWeight = { grossEq: round2(costEW.grossEq), netEq: round2(costEW.netEq) };
    curves.IHSG = { eq: round2(ihEq) };
    metrics.MinVar = packNet(costMV);
    metrics.EqualWeight = packNet(costEW);
    if (costIW) {
      curves.IndexWeight = { grossEq: round2(costIW.grossEq), netEq: round2(costIW.netEq) };
      metrics.IndexWeight = packNet(costIW);
    }
    metrics.IHSG = { ...ihMetrics, grossSharpe: ihMetrics.sharpe, grossAnnReturn: ihMetrics.annReturn, annualTurnover: 0, annualCostDrag: 0 };

    // κ-sweep at the reference variant λ (tailPenalty) — run for EVERY frequency.
    const sweep = kappaSweep.map(k => {
      const w = walkVariant(contexts, { mode: 'tailAware', tailPenalty, kappa: k, paths, optimizeMaxIter, rf, seed });
      return { kappa: k, ...packNet(costStrategy(w, contexts, hasLiquidity, rfPeriod, benchRets, ppy)) };
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
      viewMode,
      ...(membership ? { membership: {
        index: membership.index ?? null, generated: membership.generated ?? null,
        universeSize: included.length, pitStats,
      } } : {}),
      ...(viewMode === 'off' ? {} : {
        maxStalenessDays,
        factorConfig: {
          tau: factorConfig?.tau ?? 0.03,
          omegaScale: factorConfig?.omegaScale ?? 0.05,
          analystConfidence: factorConfig?.analystConfidence ?? 0.7,
          dispersionOmega: factorConfig?.dispersionOmega ?? 0.8,
        },
        viewCoverage: viewCoverageByFreq,
        viewArchive: views ? { generated: views.generated, start: views.coverage?.start, end: views.coverage?.end } : null,
      }),
    },
    window: {
      start: rebalanceRows[0]?.date, end: rebalanceRows[rebalanceRows.length - 1]?.date,
      newestListing, windowStart: appliedWindowStart, boundBy, nTickers: included.length,
      ...rfWindowStats(rfAt, rf, rebalanceRows[0]?.date, rebalanceRows[rebalanceRows.length - 1]?.date),
    },
    byFrequency,
    headline,
    limitations: [
      ...(viewMode === 'off'
        ? ['Machinery-only: no alpha signal. μ is the equilibrium prior, so Max-Sharpe reduces to the prior weights by construction (w ∝ Σ⁻¹δΣw_prior). Set viewMode to introduce a signal.']
        : [
          `View-driven (viewMode '${viewMode}'): μ carries the point-in-time analyst consensus where the archive covers a name, `
          + `${viewMode === 'analyst' ? 'and leaves the rest at the equilibrium prior' : 'and the trailing 1-year sample mean elsewhere'}.`,
          'Analyst-view coverage is NOT uniform across names or time — see params.viewCoverage and the archive\'s coverage.perTicker before reading any spread as alpha.',
          'Dividend yield inside the total-return view Q is static per ticker (no dated yield history), so Q\'s LEVEL is approximate; its cross-sectional ranking is not affected.',
        ]),
      ...(membership
        ? ['Point-in-time universe: each step holds only names that were in the index on that date (monthly snapshots, so a quarterly review can lag by up to ~4 weeks) AND had a full 365-day price window; a name IPO\'d into the index waits a year. Names whose price bars stop are treated as untradable from that bar — no forced loss is charged for a suspension.',
           'Cap prior uses the index archive\'s DATED shares-outstanding × price(t), not today\'s share count.']
        : ['Survivorship bias: the universe is the currently-liquid IDX large-caps; delisted/shrunken names are excluded.',
           'Cap-weight approximation: the equilibrium prior uses current shares-outstanding (Yahoo exposes no history) × point-in-time price.']),
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
    priorMode = 'cap',             // ANCHOR: BL prior reference weights 'cap' | 'shrunk' |
                                   // 'equal', or 'none' = no prior at all
    viewMode = 'off',              // SIGNAL: 'off' | 'analyst' | 'hybrid' | 'sample' (VIEW_MODES)
    views = null,                  // parsed analyst-views.json; required by 'analyst'/'hybrid'
    factorConfig = null,           // BL knobs: { tau, omegaScale, analystConfidence, dispersionOmega }
    maxStalenessDays = DEFAULT_MAX_STALENESS_DAYS, // older target ⇒ treated as no view
    sectorCap = null,              // per-sector weight cap (null/≥1 = off); needs SECTOR_MAP
    seed = 12345,                  // fixed RNG seed ⇒ identical settings give identical curves
                                   // (no Monte-Carlo jitter on recompute); pass null for live noise
  } = opts;

  const freq = FREQUENCIES[frequency];
  if (!freq) return { ok: false, warnings: [`Unknown frequency '${frequency}'.`] };

  const prep = prepareStrategyInputs(data, includedTickers, volHalfLife);
  if (!prep.ok) return { ok: false, warnings: prep.warnings };
  const { rf, rfAt, warnings, included, hasLiquidity, capMode, rebalanceRows, newestListing, sharedCtx } = prep;

  const grid = rebalanceGrid(rebalanceRows, freq.step);
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

  const viewLookup = views ? makeViewLookup(views, { maxStalenessDays }) : null;
  const { contexts, lookAhead, viewCoverage } = buildStepContexts(grid, {
    ...sharedCtx, priorMode, viewMode, viewLookup, factorConfig,
  });
  if (lookAhead) warnings.push(`Look-ahead guard tripped: ${lookAhead}`);
  if (viewMode !== 'off' && viewCoverage && viewCoverage.coverage < 1) {
    warnings.push(`Analyst views cover ${(viewCoverage.coverage * 100).toFixed(1)}% of ticker-steps; the rest fell back to ${viewMode === 'analyst' ? 'the equilibrium prior' : 'the trailing sample mean'}.`);
  }
  const benchRets = contexts.map(c => c.ihsgRet);
  const dates = [...contexts.map(c => c.t), grid[grid.length - 1].date];
  const round2 = arr => arr.map(v => +v.toFixed(2));
  const n = included.length;

  const total = 4; // optimized + baseline strategies that report progress
  let done = 0;
  const progress = label => { if (onProgress) onProgress(done, total, label); };

  // Same dated r_f the optimizer saw at each step (see runStrategyBacktest).
  const rfPeriod = contexts.map(c => perPeriodRate(c.rf ?? rf, ppy));

  const curves = {}, metrics = {}, attribution = {}, fees = {};
  const addStrategy = (key, weights) => {
    const costed = costStrategy(weights, contexts, hasLiquidity, rfPeriod, benchRets, ppy);
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
  const ihMetrics = seriesMetrics(benchRets, ihEq[ihEq.length - 1], rfPeriod, null, ppy);
  curves.IHSG = { eq: round2(ihEq) };
  metrics.IHSG = { ...ihMetrics, grossSharpe: ihMetrics.sharpe, grossAnnReturn: ihMetrics.annReturn, annualTurnover: 0, annualCostDrag: 0 };

  return {
    ok: true,
    frequency,
    params: { lambda, kappa, maxPositionCap, priorMode, viewMode, sectorCap, paths, optimizeMaxIter, capMode,
      costModel: hasLiquidity ? 'liquidity-aware' : 'flat',
      ...(viewMode === 'off' ? {} : { maxStalenessDays, viewCoverage }) },
    window: {
      start: dates[0], end: dates[dates.length - 1], newestListing,
      nRebalances: grid.length, nTickers: n,
      ...rfWindowStats(rfAt, rf, dates[0], dates[dates.length - 1]),
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
