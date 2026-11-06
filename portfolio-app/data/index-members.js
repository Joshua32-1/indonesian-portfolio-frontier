/**
 * index-members.js
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE as-of lookups over the point-in-time index-membership archive
 * (data/index-members.json).
 *
 * Mirrors bi-rate.js / analyst-views.js / dividends.js: the JSON is the archive, this
 * module is the only thing that reads it, every accessor is a pure function of
 * (archive, date). No I/O, no network, no DOM.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Backtesting TODAY'S index membership over a historical window is look-ahead of the
 * worst kind: a name is in LQ45 now precisely because it grew and traded up, so
 * pre-selecting current members hands the optimizer a set filtered on outcomes it could
 * not have known. Measured on this repo's own LQ45 tier, that was worth 0.68 of Sharpe
 * (1.00 → 0.32) and 31pp of annual return — and a same-size random-subset control put
 * only ~0.05 of that down to the smaller universe, so the rest was survivorship.
 *
 * ── The as-of rule ───────────────────────────────────────────────────────────
 * A lookup at time t returns the newest snapshot dated <= t, never after. Snapshots are
 * monthly (1st of month); LQ45 reviews take effect on the first TRADING day of Feb/May/
 * Aug/Nov, so a 1st-of-month snapshot can lag a review by up to ~4 weeks. That lag is
 * deliberate and safe: being stale can only withhold information, never leak it.
 *
 * ── What a member row carries ────────────────────────────────────────────────
 *   ticker   bare symbol ('BBCA')
 *   weight   index weight in PERCENT at that date; each snapshot sums to 100
 *   shares   shares outstanding in MILLIONS at that date
 *   price    traded (unadjusted) price at that date, or null — the vendor populated
 *            this for only ~53% of snapshots, so never rely on it being present
 *
 * `weight` and `shares` are the valuable fields. Both are DATED, which is what makes them
 * usable as a cap-prior input: the engine otherwise reconstructs historical market cap as
 * price(t) × sharesOutstanding_TODAY, which is wrong by every issuance and buyback since.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Index of the newest snapshot dated <= asOf, or -1. Dates are ASCENDING. */
export function idxAsOf(dates, asOf) {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= asOf) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * The snapshot in force at `asOf`, or null when `asOf` precedes the archive.
 * Returns `{ date, members: [{ ticker, weight, shares, price }] }`.
 */
export function snapshotAsOf(archive, asOf) {
  const snaps = archive?.snapshots;
  if (!snaps?.length) return null;
  const i = idxAsOf(archive.dates, asOf);
  return i < 0 ? null : snaps[i];
}

/** Bare tickers in the index at `asOf`; [] when the archive does not reach back that far. */
export function membersAsOf(archive, asOf) {
  return snapshotAsOf(archive, asOf)?.members.map(m => m.ticker) ?? [];
}

/**
 * Index weights at `asOf` as FRACTIONS summing to ~1, keyed by ticker.
 *
 * Returned as fractions rather than the archive's percent so callers can use them directly
 * as reference weights for an equilibrium prior, which is the shape computeEquilibriumReturns
 * expects. Restricted to `only` when given (renormalised over the survivors), because a
 * backtest universe is usually the index INTERSECTED with the names it has prices for.
 */
export function weightsAsOf(archive, asOf, { only = null } = {}) {
  const snap = snapshotAsOf(archive, asOf);
  if (!snap) return {};
  const keep = only ? new Set(only) : null;
  const rows = snap.members.filter(m => (!keep || keep.has(m.ticker)) && m.weight > 0);
  const total = rows.reduce((s, m) => s + m.weight, 0);
  if (!(total > 0)) return {};
  return Object.fromEntries(rows.map(m => [m.ticker, m.weight / total]));
}

/** Shares outstanding (MILLIONS) at `asOf`, keyed by ticker. Empty when not covered. */
export function sharesAsOf(archive, asOf) {
  const snap = snapshotAsOf(archive, asOf);
  if (!snap) return {};
  return Object.fromEntries(
    snap.members.filter(m => m.shares > 0).map(m => [m.ticker, m.shares]),
  );
}

/** Was `ticker` a constituent at `asOf`? */
export function wasMember(archive, ticker, asOf) {
  return membersAsOf(archive, asOf).includes(ticker);
}

/**
 * Bind an archive into a reusable lookup, mirroring makeRateLookup / makeViewLookup.
 * `fn(asOf)` → bare tickers; `.weights(asOf, opts)`, `.shares(asOf)`, `.snapshot(asOf)`,
 * `.dates`, `.universe` (every ticker that was EVER a member).
 */
export function makeMemberLookup(archive) {
  const fn = asOf => membersAsOf(archive, asOf);
  fn.weights = (asOf, opts) => weightsAsOf(archive, asOf, opts);
  fn.shares = asOf => sharesAsOf(archive, asOf);
  fn.snapshot = asOf => snapshotAsOf(archive, asOf);
  fn.dates = archive?.dates ?? [];
  fn.universe = archive?.universe ?? [];
  return fn;
}
