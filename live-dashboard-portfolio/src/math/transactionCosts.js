/**
 * transactionCosts.js — IDX transaction-cost model for the live forward tracker.
 * ─────────────────────────────────────────────────────────────────────────────
 * A standalone copy of the backtester's cost primitives
 * (backtest-portfolio/src/backtestEngine.js), kept here so the dashboard's Vercel
 * build stays self-contained (no cross-app import). The COST constants + the
 * half-spread/fee formula are identical — keep them in sync if either changes.
 *
 * Forward net-of-cost convention: the tracker holds target weights (daily-
 * rebalanced to target, the gross convention), so turnover cost is charged only
 * at the explicit frequency-rebalance points (and the one-time inception
 * deployment from cash). Intra-period daily drift is assumed costless, matching
 * the gross curve. ADV (trailing average daily VALUE, IDR) drives the liquidity-
 * dependent half-spread; absent dollar-volume → flat per-side fallback.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const COST = {
  feeBuyBps: 15,          // IDX brokerage, buy side
  feeSellBps: 25,         // IDX brokerage + levy + PPh final, sell side
  halfSpreadFloorBps: 5,  // most-liquid large-caps
  halfSpreadCeilBps: 50,  // thin names
  halfSpreadK: 30,        // halfSpreadBps = clamp(K / √ADV_bn, floor, ceil)
  flatPerSideBps: 35,     // fallback per unit traded when liquidity data is absent
  advWindow: 63,          // trailing sessions for the average-daily-value estimate
};

/** Liquidity-driven half-spread (bps) from trailing average daily value (IDR). */
export function halfSpreadBps(advIDR) {
  if (!(advIDR > 0)) return COST.halfSpreadCeilBps;
  const advBn = advIDR / 1e9;
  const raw = COST.halfSpreadK / Math.sqrt(Math.max(advBn, 0.01));
  return Math.min(COST.halfSpreadCeilBps, Math.max(COST.halfSpreadFloorBps, raw));
}

/**
 * Trailing average daily VALUE (IDR) for one asset as of a date, from the
 * enriched snapshot's dollarVol[] aligned to priceHistory.dates.
 * Returns null when dollar-volume is absent (→ caller uses the flat cost model).
 *
 * @param {{ dates: string[], dollarVol?: number[] }} priceHistory
 * @param {string} asOfDate — YYYY-MM-DD
 * @param {number} window — trailing sessions (default COST.advWindow)
 * @returns {number|null}
 */
export function trailingADV(priceHistory, asOfDate, window = COST.advWindow) {
  const dates = priceHistory?.dates;
  const dv = priceHistory?.dollarVol;
  if (!Array.isArray(dates) || !Array.isArray(dv)) return null;
  let j = -1;
  for (let i = 0; i < dates.length; i++) { if (dates[i] <= asOfDate) j = i; else break; }
  if (j < 0) return null;
  const lo = Math.max(0, j - window + 1);
  let sum = 0, cnt = 0;
  for (let i = lo; i <= j; i++) { const v = dv[i]; if (v > 0) { sum += v; cnt++; } }
  return cnt > 0 ? sum / cnt : null;
}

/**
 * Cost (fraction of portfolio) to move from wPre → wTarget, both keyed by ticker.
 * Mirrors backtestEngine.rebalanceCost but ticker-keyed (the dashboard's shape).
 * advByTicker: { ticker: advIDR } or null/empty → flat per-side fallback.
 */
export function rebalanceCostByTicker(wTarget, wPre, advByTicker = null) {
  const tickers = new Set([...Object.keys(wTarget || {}), ...Object.keys(wPre || {})]);
  let cost = 0;
  for (const tk of tickers) {
    const delta = (wTarget[tk] ?? 0) - (wPre[tk] ?? 0);
    if (Math.abs(delta) < 1e-12) continue;
    const adv = advByTicker ? advByTicker[tk] : null;
    if (adv != null && adv > 0) {
      const hs = halfSpreadBps(adv) / 1e4;
      const fee = (delta > 0 ? COST.feeBuyBps : COST.feeSellBps) / 1e4;
      cost += Math.abs(delta) * (hs + fee);
    } else {
      cost += Math.abs(delta) * (COST.flatPerSideBps / 1e4);
    }
  }
  return cost;
}

/**
 * Subset a weekly rebalances[] to a coarser cadence by keeping the FIRST
 * rebalance in each month / quarter and holding it until the next kept one.
 * Faithful forward overlay: the weekly cron re-optimizes every week, so the
 * month/quarter-boundary optimization is what a monthly/quarterly run would use.
 *
 * @param {{ effective: string }[]} rebalances — ascending by effective date
 * @param {'weekly'|'monthly'|'quarterly'} frequency
 */
export function applyFrequencyToRebalances(rebalances, frequency) {
  if (frequency === 'weekly' || !rebalances?.length) return rebalances ?? [];
  const keyOf = frequency === 'monthly'
    ? (d) => d.slice(0, 7)                                                  // YYYY-MM
    : (d) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3)}`; // YYYY-Qn
  const seen = new Set();
  const out = [];
  for (const r of rebalances) {
    const k = keyOf(r.effective);
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}
