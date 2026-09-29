/**
 * dividends.js
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE as-of lookups over the dividend record (data/dividends.json).
 *
 * Mirrors bi-rate.js and analyst-views.js: the JSON is the archive, this module is
 * the only thing that reads it, every accessor is a pure function of (archive, date).
 * No I/O, no network, no DOM.
 *
 * ── What a stored event is ───────────────────────────────────────────────────
 * Each event is a DIMENSIONLESS yield fraction measured at its own ex-date:
 *
 *     y_s = amount_s / close_s      (both from Yahoo's split-adjusted series)
 *
 * Storing the ratio rather than the rupiah amount is what makes this composable.
 * Yahoo back-adjusts amounts for splits; Bloomberg's price column in the target
 * archive is the contemporaneous traded price. Dividing one by the other is wrong
 * by the split factor — BBCA's 2015 payment is 19.6 against Yahoo's 2,645 but was
 * ~100 against a traded ~13,000. The ratio is 0.74% either way, so a ratio crosses
 * between the two conventions safely and a rupiah amount does not.
 *
 * ── Trailing-twelve-month yield ──────────────────────────────────────────────
 *     y(t) = SUM of y_s over ex-dates s in (t - windowDays, t]
 *
 * Each dividend is measured against the price prevailing when it was paid — the
 * yield actually earned — rather than (SUM amount) / price(t), which would rescale
 * a payment made at one price by a price from up to a year later. On IDX, where a
 * name can halve inside a year, those differ materially.
 *
 * The window is HALF-OPEN on the left and CLOSED on the right: an ex-date exactly
 * `windowDays` back has rolled out; one falling exactly on `t` counts. That keeps
 * y(t) look-ahead-free — it can never include a dividend that had not yet gone ex.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Trailing window for a TTM yield. */
export const DEFAULT_WINDOW_DAYS = 365;

/** ISO date `days` before `iso`. */
export function shiftISO(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Trailing-twelve-month dividend yield for `ticker` as of `asOf`, as a fraction.
 *
 * Returns 0 for a name with no events in the window — which is the correct economic
 * answer (it paid nothing), NOT a "missing data" signal. Use `hasRecord` to tell a
 * genuine non-payer from a ticker the archive never covered.
 */
export function ttmYieldAsOf(archive, ticker, asOf, { windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const rec = archive?.tickers?.[ticker];
  if (!rec?.events?.length) return 0;
  const from = shiftISO(asOf, -windowDays);
  let sum = 0;
  for (const e of rec.events) {
    if (e.d <= from) continue;      // rolled out of the window
    if (e.d > asOf) break;          // not yet ex — events are ASCENDING, so stop
    sum += e.y;
  }
  return sum;
}

/** True when the archive carries this ticker at all (even with zero events). */
export function hasRecord(archive, ticker) {
  return Boolean(archive?.tickers?.[ticker]);
}

/**
 * Compact the events into the dated {d, y} series the analyst-view archive embeds.
 * Kept here so the shape is defined once, beside the semantics that read it.
 */
export function toSeries(archive, ticker) {
  const rec = archive?.tickers?.[ticker];
  if (!rec?.events?.length) return [];
  return rec.events.map(e => ({ d: e.d, y: e.y }));
}

/**
 * Bind an archive into a reusable lookup: `fn(ticker, asOf) -> yield fraction`.
 * Also exposes `.has(ticker)`, `.tickers`, `.windowDays`.
 */
export function makeYieldLookup(archive, { windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const fn = (ticker, asOf) => ttmYieldAsOf(archive, ticker, asOf, { windowDays });
  fn.has = ticker => hasRecord(archive, ticker);
  fn.tickers = Object.keys(archive?.tickers ?? {});
  fn.windowDays = windowDays;
  return fn;
}
