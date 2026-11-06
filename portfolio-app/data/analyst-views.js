/**
 * analyst-views.js
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE as-of lookups over the analyst-target archive (data/analyst-views.json).
 *
 * Mirrors bi-rate.js: the JSON is the archive, this module is the only thing that
 * reads it, and every accessor is a pure function of (archive, date). No I/O, no
 * network, no DOM — so the backtester can import it directly and validate-* can
 * exercise it offline.
 *
 * ── The one rule that matters ────────────────────────────────────────────────
 * A lookup at time t returns the newest row with date <= t, or null. Never a row
 * dated after t. This is what makes a view-driven backtest look-ahead-free: at a
 * 2018 rebalance the optimizer sees the consensus target as it stood in 2018.
 *
 * ── The dividend component of Q ──────────────────────────────────────────────
 * Q is a TOTAL return: (target - price)/price + y. `y` is a DATED trailing-12-month
 * yield read from the archive's embedded `div` series (built by fetch-dividends.mjs
 * → dividends.json → folded in by import-analyst-views.mjs). It falls back to the
 * static snapshot value only for names the dividend record does not cover, and the
 * returned view reports which was used via `dividendSource`.
 *
 * ── Staleness ────────────────────────────────────────────────────────────────
 * Coverage is not uniform. Bloomberg's weekly series has genuine holes (BNGA ~448
 * days, MDKA ~763) where no consensus was published. Returning a two-year-old
 * target as if it were current would be worse than having no view, so a lookup
 * older than `maxStalenessDays` resolves to null and the caller falls back to its
 * own estimator (in the backtest: the trailing sample mean). Normal weekly gaps
 * are <= 7 days; the largest legitimate publication gap in the archive is ~49
 * days (BIRD), so the 120-day default keeps every real observation and rejects
 * only the true holes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Trailing window for the dividend component of Q. Matches dividends.js — kept as a
 * literal rather than an import so this module stays a pure reader of ONE archive.
 */
export const DIVIDEND_WINDOW_DAYS = 365;

/** Default staleness cutoff — see the module header for how it was chosen. */
export const DEFAULT_MAX_STALENESS_DAYS = 120;

/**
 * Q CLAMP. A consensus target that has not been revised while the price collapsed implies
 * an absurd upside — MNCN prints a 1300 target against a 200 price, i.e. +550%. Unclamped,
 * that becomes an enormous Black-Litterman view and the optimizer piles into a dying stock.
 * 200% is far outside any plausible 12-month total return while still leaving genuine
 * deep-value views intact (99.6% of ticker-steps sit below it).
 */
export const DEFAULT_MAX_Q = 2.0;

/**
 * CONSENSUS-QUALITY GATE. Two distinct failure modes, both measured on the trailing window
 * and both look-ahead-free (only prints at or before the lookup date are read):
 *
 *   FROZEN  — the target is never revised. The consensus has effectively been abandoned;
 *             the number on file is a fossil. >90% of the window unchanged.
 *   JUMPY   — the target lurches in single steps, the signature of one or two analysts
 *             where a single revision moves the whole "consensus". Max step >25%.
 *
 * ── On the thresholds, and why they are not fitted ───────────────────────────
 * They are chosen on economic grounds, not from the tail of the sample: a target unrevised
 * for six months is an abandoned consensus, and a mean target that moves 25% in one step
 * cannot rest on many contributors. Both sit ABOVE the 95th percentile of core-tier names
 * in the pre-window sample (pre-2016-08: frozen p95 69%, jump p95 16.5%) AND in the full
 * sample (73%, 17.0%) — the two agree closely, so nothing here was tuned on the test period.
 *
 * Empirically each gate earns its place: a step flagged FROZEN is 15x more likely to imply
 * >200% upside, one flagged JUMPY 12x more likely, and both rates rise monotonically from
 * the core tier to the historical one — they are picking out thin coverage, which is the point.
 *
 * ── Walk-forward by construction ─────────────────────────────────────────────
 * consensusQuality reads target[k] only for k <= idxAsOf(dates, asOf), so the verdict at
 * time t depends on nothing published after t. validate-analyst-views.mjs proves this by
 * truncation rather than by inspection: it rebuilds the archive as it stood on each probe
 * date and asserts the gate reaches an identical decision.
 *
 * A gated lookup returns null, exactly as a stale one does, so the caller falls back to its
 * own estimator rather than acting on a number the data cannot support.
 */
export const DEFAULT_STABILITY = Object.freeze({
  window: 26,          // trailing consensus prints (~6 months of weekly data)
  minObs: 10,          // below this there is not enough history to judge; do not gate
  maxFrozenFrac: 0.9,  // share of the window with no revision at all
  maxJump: 0.25,       // largest single |Δ ln target| tolerated
});

const round4 = v => Math.round(v * 1e4) / 1e4;

/** Whole days from ISO date `a` to ISO date `b` (negative if b precedes a). */
export function daysBetweenISO(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isNaN(ms) ? NaN : Math.round(ms / 86400000);
}

/**
 * Index of the newest entry in an ASCENDING ISO date array with dates[i] <= asOf.
 * −1 when every entry postdates asOf. Binary search — the archive is ~48k rows across
 * 86 tickers and a walk-forward hits it once per (step × ticker).
 */
export function idxAsOf(dates, asOf) {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= asOf) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Trailing-twelve-month dividend yield from the embedded dated series, as a fraction.
 *
 * Window is half-open left / closed right, so a dividend cannot be counted before it
 * has gone ex — the same look-ahead discipline the targets follow. Returns null when
 * the ticker carries no dated series at all, so the caller can fall back to the static
 * value; a covered name that simply paid nothing this year correctly returns 0.
 */
function ttmDividendYield(div, asOf) {
  if (!div?.length) return null;
  const from = new Date(Date.parse(`${asOf}T00:00:00Z`) - DIVIDEND_WINDOW_DAYS * 86400000)
    .toISOString().slice(0, 10);
  let sum = 0;
  for (const e of div) {
    if (e.d <= from) continue;
    if (e.d > asOf) break;          // ASCENDING — nothing later can qualify
    sum += e.y;
  }
  return sum;
}

/**
 * Consensus quality over the `window` prints ENDING AT index `i` (inclusive).
 * Returns { frozenFrac, maxJump, obs } or null when there is too little history to judge.
 * Reads only indices <= i, so it can never see a revision that had not happened yet.
 */
function consensusQuality(target, i, { window, minObs }) {
  const lo = Math.max(1, i - window + 1);
  let frozen = 0, maxJump = 0, obs = 0;
  for (let k = lo; k <= i; k++) {
    const a = target[k - 1], b = target[k];
    if (!(a > 0) || !(b > 0)) continue;
    const d = Math.abs(Math.log(b / a));
    if (d < 1e-9) frozen++;
    if (d > maxJump) maxJump = d;
    obs++;
  }
  if (obs < minObs) return null;
  return { frozenFrac: frozen / obs, maxJump, obs };
}

/** Newest enrichment row (dispersion / analyst count) at or before asOf, else null. */
function enrichAsOf(enrich, asOf) {
  if (!enrich?.length) return null;
  let ans = null;
  for (const e of enrich) {           // short list (one row per weekly capture)
    if (e.d <= asOf) ans = e; else break;
  }
  return ans;
}

/**
 * Resolve one ticker's analyst view as of a date.
 *
 * @param {object} archive   parsed analyst-views.json
 * @param {string} ticker    bare symbol ('BBCA')
 * @param {string} asOf      ISO date of the rebalance step
 * @param {{maxStalenessDays?:number}} [opts]
 * @returns {null | {
 *   ticker:string, asOf:string, date:string, ageDays:number,
 *   target:number, price:number, upside:number, totalReturn:number,
 *   dividendYield:number, analysts:number|null, dispersion:number|null
 * }}  `totalReturn` is Q — the 12-month TOTAL return view, the space π lives in.
 */
export function viewAsOf(archive, ticker, asOf, {
  maxStalenessDays = DEFAULT_MAX_STALENESS_DAYS,
  maxQ = DEFAULT_MAX_Q,
  stability = DEFAULT_STABILITY,
} = {}) {
  const rec = archive?.tickers?.[ticker];
  if (!rec) return null;
  const { dates, target, price } = rec.targets ?? {};
  if (!dates?.length) return null;

  const i = idxAsOf(dates, asOf);
  if (i < 0) return null;                       // archive starts after this step

  const ageDays = daysBetweenISO(dates[i], asOf);
  if (ageDays > maxStalenessDays) return null;  // a hole, not an observation

  const t = target[i], p = price[i];
  if (!(t > 0) || !(p > 0)) return null;

  // Quality gate BEFORE the view is built: an abandoned or one-analyst consensus is not a
  // weak view to be down-weighted, it is an absent one. Returning null hands the caller
  // back to its own estimator, exactly as the staleness cutoff does.
  const qual = stability ? consensusQuality(target, i, stability) : null;
  if (qual && (qual.frozenFrac > stability.maxFrozenFrac || qual.maxJump > stability.maxJump)) {
    return null;
  }

  // Upside is computed from Bloomberg's OWN contemporaneous price, not the Yahoo
  // series the backtest trades on. The two differ (adjusted vs raw close, and a
  // Wed-vs-Fri date offset), and it is the RATIO that carries the analyst's view —
  // mixing sources here would inject a spurious few percent into every step.
  const upsideRaw = (t - p) / p;
  // DATED yield where the dividend record covers the name, else the static snapshot
  // value. The static path is a documented approximation and now a narrow fallback:
  // it applies one present-day number to every historical step.
  const dated = ttmDividendYield(rec.div, asOf);
  const y = dated ?? rec.static?.dividendYield ?? 0;
  const e = enrichAsOf(rec.enrich, asOf);

  // Clamp the TOTAL return, not the upside, so the cap means what it says: no view claims
  // more than maxQ over twelve months. The downside needs no clamp — a target cannot go
  // below zero, so upside is already bounded at -100%.
  const totalRaw = upsideRaw + y;
  const totalReturn = maxQ != null && totalRaw > maxQ ? maxQ : totalRaw;
  const clamped = totalReturn !== totalRaw;

  return {
    ticker, asOf, date: dates[i], ageDays,
    target: t, price: p,
    upside: upsideRaw,
    totalReturn,
    totalReturnRaw: totalRaw,
    clamped,
    frozenFrac: qual ? round4(qual.frozenFrac) : null,
    maxJump: qual ? round4(qual.maxJump) : null,
    dividendYield: y,
    dividendSource: dated != null ? 'dated' : (rec.static?.dividendYield ? 'static' : 'none'),
    analysts: e?.analysts ?? rec.static?.totalAnalysts ?? null,
    dispersion: e?.dispersion ?? rec.static?.dispersion ?? null,
  };
}

/**
 * Bind an archive into a reusable lookup, mirroring makeRateLookup's shape.
 * `fn.has(ticker)` answers the "is this name covered at all?" question without a date.
 *
 * @returns {(ticker:string, asOf:string) => ReturnType<typeof viewAsOf>}
 */
export function makeViewLookup(archive, opts = {}) {
  const fn = (ticker, asOf) => viewAsOf(archive, ticker, asOf, opts);
  fn.mode = archive?.tickers ? 'archive' : 'empty';
  fn.archive = archive ?? null;
  fn.maxStalenessDays = opts.maxStalenessDays ?? DEFAULT_MAX_STALENESS_DAYS;
  fn.has = (ticker) => Boolean(archive?.tickers?.[ticker]?.targets?.dates?.length);
  fn.tickers = archive?.tickers ? Object.keys(archive.tickers) : [];
  return fn;
}

/**
 * Coverage of a ticker list over a date grid — how often a view actually resolves.
 * The backtest reports this so a run is never silently "view-driven" on 30% of steps.
 *
 * @returns {{ steps:number, tickers:number, cells:number, covered:number,
 *             coverage:number, perTicker:Record<string,{covered:number,coverage:number}> }}
 */
export function coverageOver(archive, tickers, grid, opts = {}) {
  const look = makeViewLookup(archive, opts);
  const perTicker = {};
  let covered = 0;
  for (const tk of tickers) {
    let c = 0;
    for (const d of grid) if (look(tk, d)) c++;
    perTicker[tk] = { covered: c, coverage: grid.length ? c / grid.length : 0 };
    covered += c;
  }
  const cells = tickers.length * grid.length;
  return {
    steps: grid.length, tickers: tickers.length, cells, covered,
    coverage: cells ? covered / cells : 0,
    perTicker,
  };
}
