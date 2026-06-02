/**
 * priceAlign.js
 * Extracted from portfolio-app/src/math/matrixEngine.js.
 * Pure price-alignment helpers for IDX weekly series (no optimizer deps).
 */

/**
 * Maps a Yahoo weekly bar to the canonical Tuesday week key used by IDX listings.
 * Sunday bars (NCKL etc.) are shifted +2 days to match Tuesday anchors.
 * @param {string} isoDate — YYYY-MM-DD
 * @returns {string}
 */
export function canonicalWeeklyKey(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const dow = d.getUTCDay();

  if (dow === 2) return isoDate;

  if (dow === 0) {
    d.setUTCDate(d.getUTCDate() + 2);
    return d.toISOString().slice(0, 10);
  }

  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (dow - 1));
  const tuesday = new Date(monday);
  tuesday.setUTCDate(monday.getUTCDate() + 1);
  return tuesday.toISOString().slice(0, 10);
}

/**
 * Indexes weekly prices by canonical week key. Duplicate keys keep the latest bar.
 * @param {{ interval?: string, dates: string[], adjClose: number[] }} history
 * @returns {Map<string, { sourceDate: string, price: number }>}
 */
function historyByWeekKey(history) {
  const map = new Map();
  const dates = history?.dates ?? [];
  const prices = history?.adjClose ?? [];

  for (let i = 0; i < dates.length; i++) {
    const sourceDate = dates[i];
    const price = prices[i];
    if (price == null) continue;
    const key = canonicalWeeklyKey(sourceDate);
    const prev = map.get(key);
    if (!prev || sourceDate > prev.sourceDate) {
      map.set(key, { sourceDate, price });
    }
  }
  return map;
}

/**
 * Returns sorted intersection of canonical weekly keys across all histories.
 * @param {Array<{ interval?: string, dates: string[], adjClose: number[] }>} histories
 * @returns {string[]}
 */
export function commonPriceDates(histories) {
  if (!histories?.length) return [];
  const maps = histories.map(historyByWeekKey);
  return [...maps[0].keys()]
    .filter(key => maps.every(map => map.has(key)))
    .sort();
}

/**
 * Builds aligned close-price rows on common canonical weekly keys.
 * @param {{ id: string, history: { dates: string[], adjClose: number[] } }[]} series
 * @returns {Array<{ date: string, [id: string]: number }>}
 */
export function alignPriceSeries(series) {
  const keyed = series.map(s => ({ id: s.id, map: historyByWeekKey(s.history) }));
  const common = commonPriceDates(series.map(s => s.history));

  return common.map(key => {
    const row = { date: key };
    for (const { id, map } of keyed) {
      row[id] = map.get(key)?.price;
    }
    return row;
  });
}
