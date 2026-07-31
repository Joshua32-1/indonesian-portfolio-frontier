/**
 * performance.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Ex-post performance statistics computed from a realized return series.
 *
 * The Sharpe estimator here is the CANONICAL one for the monorepo. The backtester
 * imports it directly; the live dashboard keeps a small mirror in
 * live-dashboard-portfolio/src/math/portfolioIndex.js because its Vercel build root
 * is that app's directory and cannot reach across the repo (CLAUDE.md: the apps share
 * data contracts, not code). KEEP THE TWO IN SYNC — a divergence would make the
 * forward test and the backtest quietly incomparable, which is the one comparison
 * both exist to support.
 *
 * Pure module: no React, no I/O, no DOM (golden rule 2).
 *
 * ── Why not (annualized return − r_f) / annualized vol ──────────────────────
 * Both apps used to divide a GEOMETRIC annualized return (CAGR) by an arithmetic vol,
 * subtracting a single compounded annual r_f once at the end. Two problems:
 *
 * 1. It STRUCTURALLY cannot express a policy rate that moves inside the window. One
 *    scalar is subtracted from one whole-window number, so a BI-Rate that went 6.75%
 *    → 3.75% → 6.00% across the backtest is unrepresentable. That alone forces the
 *    change, since the whole point of the dated r_f series is to stop pretending
 *    today's rate applied in 2013.
 *
 * 2. It is not the Sharpe ratio as defined. Sharpe is a moment ratio of the EXCESS
 *    return series; mixing a compounded numerator with an arithmetic denominator is a
 *    practitioner shortcut, and it left Sharpe as the odd metric out next to the
 *    Information Ratio, which the backtester already computes the standard way as
 *    mean(active)·√ppy / trackingError.
 *
 * The size of the correction is NOT a clean σ/2 offset — that expansion (from
 * CAGR ≈ arithmetic − σ²/2) is swamped in practice by a second effect: this estimator
 * scales the mean excess by ppy, while CAGR compounds it, and the same simple-vs-
 * compound gap applies to r_f itself. The two effects push in OPPOSITE directions, so
 * the net change is series-dependent and can go either way. Measured on a 13-year
 * synthetic run, most arms rose by 0.00–0.07 while the highest-return arm FELL by 0.11.
 * Expect a re-baseline whose sign varies by arm, not a uniform shift.
 *
 * The denominator is unchanged for a constant rate: subtracting a fixed per-period
 * rate cannot move a standard deviation, so std(e)·√ppy is exactly the annVol still
 * displayed. Only the numerator changed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Arithmetic mean; 0 for an empty series. */
export function mean(xs) {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

/** Sample standard deviation (n−1). Matches the backtester's existing convention. */
export function stdev(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(Math.max(0, xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1)));
}

/**
 * Per-period excess returns e_t = r_t − rf_t.
 *
 * `rfPeriod` is the risk-free rate ALREADY expressed per period (use perPeriodRate in
 * data/bi-rate.js to de-annualize). Accepts either:
 *   • an array aligned 1:1 with `periodRets` — the dated case, where each period is
 *     charged the policy rate that was actually in effect during it; or
 *   • a single number, applied to every period.
 *
 * Both inputs must be SIMPLE returns. Mixing a log return series with a simple rf
 * shifts the mean by ≈σ²/2 and would open a wedge between the two apps.
 *
 * @param {number[]} periodRets
 * @param {number[]|number} rfPeriod
 * @returns {number[]}
 */
export function excessReturns(periodRets, rfPeriod) {
  if (Array.isArray(rfPeriod)) {
    return periodRets.map((r, i) => r - (rfPeriod[i] ?? rfPeriod[rfPeriod.length - 1] ?? 0));
  }
  const rf = Number.isFinite(rfPeriod) ? rfPeriod : 0;
  return periodRets.map(r => r - rf);
}

/**
 * Annualized Sharpe ratio from per-period excess returns:
 *
 *     Sharpe = mean(e_t) / std(e_t) × √ppy
 *
 * Note this does NOT reconstruct from the displayed annReturn/annVol pair: the
 * numerator is arithmetic (not the geometric CAGR shown to users) and the denominator
 * is the std of EXCESS returns (not of raw returns). The two vols agree to ~3 decimals
 * for a slow-moving policy rate, but the means genuinely differ — that difference is
 * the whole point of the change.
 *
 * @param {number[]} periodRets      simple returns, one per rebalance period
 * @param {number[]|number} rfPeriod per-period risk-free rate(s)
 * @param {number} periodsPerYear    52 weekly / 13 monthly / 4 quarterly / 252 daily
 * @returns {number}  0 when the series is degenerate (< 2 points, or zero vol)
 */
export function sharpeFromExcess(periodRets, rfPeriod, periodsPerYear) {
  if (!Array.isArray(periodRets) || periodRets.length < 2 || !(periodsPerYear > 0)) return 0;
  const e = excessReturns(periodRets, rfPeriod);
  const sd = stdev(e);
  if (!(sd > 0)) return 0;
  return (mean(e) / sd) * Math.sqrt(periodsPerYear);
}
