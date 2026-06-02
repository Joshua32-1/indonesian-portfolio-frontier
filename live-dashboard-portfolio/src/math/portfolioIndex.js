/**
 * portfolioIndex.js
 * Builds stitched indexed performance series for tracked portfolios.
 *
 * Stitching rule: each portfolio has a rebalances[] array sorted by effective date.
 * Weights apply from their effective date forward; the index level NEVER resets
 * on rebalance — it compounds continuously from inception.
 *
 * Interval: daily adjusted close (IDX trading days only — weekends and holidays
 * have no bar and are not represented in the series).
 */

import { alignPriceSeries } from './priceAlign.js';

/**
 * Returns the weight set active on or before a given ISO date.
 * @param {{ effective: string, weights: Record<string,number> }[]} rebalances - sorted ascending
 * @param {string} barDate — YYYY-MM-DD of the current daily bar
 * @returns {Record<string,number>}
 */
export function weightsAtDate(rebalances, barDate) {
  if (!rebalances?.length) return {};
  let active = rebalances[0].weights;
  for (const r of rebalances) {
    if (r.effective <= barDate) active = r.weights;
    else break;
  }
  return active;
}

/**
 * Returns decimal log-returns from a price array (oldest → newest).
 * @param {number[]} prices
 * @returns {number[]}
 */
function decimalLogReturns(prices) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] != null && prices[i - 1] != null && prices[i - 1] > 0) {
      rets.push(Math.log(prices[i] / prices[i - 1]));
    } else {
      rets.push(0);
    }
  }
  return rets;
}

/**
 * Builds a stitched indexed series (base 100 at first daily bar >= inception) for one portfolio.
 *
 * @param {{
 *   id: string,
 *   rebalances: { effective: string, weights: Record<string,number> }[]
 * }} portfolio
 * @param {Array<{ ticker: string, priceHistory: { dates: string[], adjClose: number[] } }>} assets
 * @param {{ dates: string[], adjClose: number[] }} benchmarkHistory - IHSG
 * @param {string} inception - ISO date; series starts from first daily bar >= inception
 * @returns {{ date: string, value: number }[]} — indexed to 100 at inception
 */
export function buildTrackerSeries(portfolio, assets, benchmarkHistory, inception) {
  const rebalances = [...(portfolio.rebalances ?? [])].sort((a, b) =>
    a.effective < b.effective ? -1 : 1,
  );

  // Collect all tickers referenced across all rebalances
  const usedTickers = new Set(
    rebalances.flatMap(r => Object.keys(r.weights ?? {})),
  );
  const relevantAssets = assets.filter(a => usedTickers.has(a.ticker));
  if (!relevantAssets.length) return [];

  // Align all asset prices (no IHSG needed here — built separately)
  const series = relevantAssets.map(a => ({ id: a.ticker, history: a.priceHistory }));
  const aligned = alignPriceSeries(series).filter(row => row.date >= inception);
  if (aligned.length < 2) return [];

  // Build per-row portfolio return and compound into an index
  const result = [];
  let idx = 100;

  for (let t = 0; t < aligned.length; t++) {
    const row = aligned[t];
    if (t === 0) {
      result.push({ date: row.date, value: 100 });
      continue;
    }
    const prevRow = aligned[t - 1];
    const w = weightsAtDate(rebalances, row.date);

    let rp = 0;
    for (const a of relevantAssets) {
      const px0 = prevRow[a.ticker];
      const px1 = row[a.ticker];
      if (px0 > 0 && px1 != null) {
        const wi = w[a.ticker] ?? 0;
        rp += wi * Math.log(px1 / px0);
      }
    }

    idx *= Math.exp(rp);
    result.push({ date: row.date, value: +idx.toFixed(4) });
  }

  return result;
}

/**
 * Builds the IHSG indexed series (base 100 at first daily bar >= inception).
 * @param {{ dates: string[], adjClose: number[] }} benchmarkHistory
 * @param {string} inception
 * @returns {{ date: string, value: number }[]}
 */
export function buildIHSGSeries(benchmarkHistory, inception) {
  const dates = benchmarkHistory?.dates ?? [];
  const prices = benchmarkHistory?.adjClose ?? [];

  const rows = [];
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] >= inception && prices[i] != null) rows.push({ date: dates[i], price: prices[i] });
  }
  if (rows.length < 2) return [];

  const base = rows[0].price;
  return rows.map(r => ({ date: r.date, value: +(r.price / base * 100).toFixed(4) }));
}

/**
 * Merges per-portfolio indexed series into Recharts row format.
 * Dates are the IHSG dates; portfolio values interpolate/null if no data.
 *
 * @param {{ id: string, series: { date: string, value: number }[] }[]} allSeries
 * @returns {Array<{ date: string, [id: string]: number|null }>}
 */
export function mergeChartRows(allSeries) {
  // Build union of all dates
  const dateSet = new Set();
  for (const s of allSeries) s.series.forEach(r => dateSet.add(r.date));
  const dates = [...dateSet].sort();

  // Index each series by date for O(1) lookup
  const maps = allSeries.map(s => {
    const m = new Map(s.series.map(r => [r.date, r.value]));
    return { id: s.id, m };
  });

  return dates.map(date => {
    const row = { date };
    for (const { id, m } of maps) row[id] = m.get(date) ?? null;
    return row;
  });
}

/**
 * Since-inception return from an indexed series.
 * @param {{ date: string, value: number }[]} series
 * @returns {number|null} — decimal (0.12 = +12%)
 */
export function sinceInceptionReturn(series) {
  if (!series?.length) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  if (!first) return null;
  return last / first - 1;
}

/**
 * Latest effective date across all rebalances.
 * @param {{ effective: string, weights: Record<string,number> }[]} rebalances
 * @returns {string|null}
 */
export function latestRebalanceDate(rebalances) {
  if (!rebalances?.length) return null;
  return [...rebalances].sort((a, b) => (a.effective < b.effective ? 1 : -1))[0].effective;
}

/**
 * Returns the latest weight set for a portfolio.
 * @param {{ rebalances: { effective: string, weights: Record<string,number> }[] }} portfolio
 * @returns {Record<string,number>}
 */
export function latestWeights(portfolio) {
  const sorted = [...(portfolio.rebalances ?? [])].sort((a, b) =>
    a.effective < b.effective ? 1 : -1,
  );
  return sorted[0]?.weights ?? {};
}
