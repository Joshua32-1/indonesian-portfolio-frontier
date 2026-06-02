/**
 * priceAlign.js
 * Pure price-alignment helpers for IDX daily series.
 *
 * Aligns by raw ISO date (YYYY-MM-DD). Only dates present in every series
 * are kept (intersection), so IDX holidays and Yahoo data gaps are silently
 * dropped rather than breaking the index calculation.
 */

/**
 * Indexes a price history by ISO date. Only non-null prices are stored.
 * @param {{ dates: string[], adjClose: number[] }} history
 * @returns {Map<string, number>}
 */
function historyByDate(history) {
  const map = new Map();
  const dates  = history?.dates   ?? [];
  const prices = history?.adjClose ?? [];
  for (let i = 0; i < dates.length; i++) {
    if (prices[i] != null) map.set(dates[i], prices[i]);
  }
  return map;
}

/**
 * Returns the sorted intersection of ISO dates across all price histories.
 * @param {Array<{ dates: string[], adjClose: number[] }>} histories
 * @returns {string[]}
 */
export function commonPriceDates(histories) {
  if (!histories?.length) return [];
  const maps = histories.map(historyByDate);
  return [...maps[0].keys()]
    .filter(date => maps.every(m => m.has(date)))
    .sort();
}

/**
 * Builds aligned close-price rows on common ISO trading-day dates.
 * @param {{ id: string, history: { dates: string[], adjClose: number[] } }[]} series
 * @returns {Array<{ date: string, [id: string]: number }>}
 */
export function alignPriceSeries(series) {
  const keyed  = series.map(s => ({ id: s.id, map: historyByDate(s.history) }));
  const common = commonPriceDates(series.map(s => s.history));

  return common.map(date => {
    const row = { date };
    for (const { id, map } of keyed) row[id] = map.get(date);
    return row;
  });
}
