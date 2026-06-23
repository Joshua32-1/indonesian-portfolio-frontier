/**
 * attribution.js
 * Carino-linked return attribution + ex-post risk contribution for live forward-test portfolios.
 * Pure JS — no React, no I/O.
 */

import { alignPriceSeries } from './priceAlign.js';
import { weightsAtDate }    from './portfolioIndex.js';

/**
 * Builds per-asset return and risk attribution for a single portfolio strategy.
 *
 * @param {{ id: string, rebalances: { effective: string, weights: Record<string,number> }[] }} portfolio
 * @param {Array<{ ticker: string, priceHistory: { dates: string[], adjClose: number[] } }>} assets
 * @param {string} inception - ISO date; attribution starts from first daily bar >= inception
 *
 * @returns {{
 *   rows: Array<{ ticker, avgWeight, returnContrib, returnShare, riskContrib }>,
 *   weightRows: Array<{ date: string, [ticker: string]: number }>,
 *   totalReturn: number,
 *   order: string[],
 * }}
 */
export function buildLiveAttribution(portfolio, assets, inception) {
  const rebalances = [...(portfolio.rebalances ?? [])].sort(
    (a, b) => (a.effective < b.effective ? -1 : 1),
  );

  const usedTickers = [
    ...new Set(rebalances.flatMap(r => Object.keys(r.weights ?? {}))),
  ];

  // weightRows: one entry per rebalance, weights in % (for the stacked-area chart)
  const weightRows = rebalances.map(r => {
    const row = { date: r.effective };
    for (const [t, w] of Object.entries(r.weights ?? {})) {
      row[t] = +(w * 100).toFixed(2);
    }
    return row;
  });

  // Align daily prices for all used tickers from inception onward
  const relevant = assets.filter(a => usedTickers.includes(a.ticker));
  const aligned  = alignPriceSeries(
    relevant.map(a => ({ id: a.ticker, history: a.priceHistory })),
  ).filter(row => row.date >= inception);

  if (aligned.length < 2) {
    return { rows: [], weightRows, totalReturn: 0, order: usedTickers };
  }

  const n = aligned.length - 1;
  const portRets  = [];
  const cByTicker = Object.fromEntries(usedTickers.map(t => [t, []]));
  const wByDay    = Object.fromEntries(usedTickers.map(t => [t, 0]));

  for (let i = 1; i < aligned.length; i++) {
    const cur  = aligned[i];
    const prev = aligned[i - 1];
    const w    = weightsAtDate(rebalances, cur.date);
    let rp = 0;

    for (const t of usedTickers) {
      const p0 = prev[t];
      const p1 = cur[t];
      const c  = (p0 > 0 && p1 != null) ? (w[t] ?? 0) * Math.log(p1 / p0) : 0;
      cByTicker[t].push(c);
      wByDay[t] += (w[t] ?? 0);
      rp += c;
    }

    portRets.push(rp);
  }

  // Total portfolio log-return → arithmetic return + Carino linking factor K
  const logR = portRets.reduce((s, r) => s + r, 0);
  const R    = Math.exp(logR) - 1;
  const K    = Math.abs(R) > 1e-12 ? Math.log(1 + R) / R : 1;

  // Portfolio variance for risk-contribution denominator
  const rpMean = portRets.reduce((s, r) => s + r, 0) / portRets.length;
  const rpVar  = portRets.reduce((s, r) => s + (r - rpMean) ** 2, 0) / (portRets.length - 1 || 1);

  const rows = usedTickers.map(t => {
    const cs     = cByTicker[t];
    const csMean = cs.reduce((s, c) => s + c, 0) / cs.length;
    const cov    = cs.reduce((s, c, i) => s + (c - csMean) * (portRets[i] - rpMean), 0) / (cs.length - 1 || 1);

    // Carino-linked return contribution (sums to R across all tickers)
    const returnContrib = cs.reduce((s, c, i) => {
      const r  = portRets[i];
      const kt = Math.abs(r) > 1e-12 ? Math.log(1 + r) / r : 1;
      return s + (kt / K) * c;
    }, 0);

    return {
      ticker:       t,
      avgWeight:    n > 0 ? wByDay[t] / n : 0,
      returnContrib,
      returnShare:  R !== 0 ? returnContrib / R : 0,
      riskContrib:  rpVar > 0 ? cov / rpVar : 0,
    };
  });

  // Normalize risk contributions for floating-point safety (they should sum to 1)
  const riskSum = rows.reduce((s, r) => s + r.riskContrib, 0);
  if (riskSum !== 0) for (const r of rows) r.riskContrib /= riskSum;

  rows.sort((a, b) => b.returnContrib - a.returnContrib);

  // order: tickers by descending average weight (for chart legend, largest band first)
  const order = [...rows]
    .sort((a, b) => b.avgWeight - a.avgWeight)
    .map(r => r.ticker);

  return { rows, weightRows, totalReturn: R, order };
}
