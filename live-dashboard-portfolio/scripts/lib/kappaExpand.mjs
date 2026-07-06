/**
 * kappaExpand.mjs — shared axes + κ (turnover-penalty) blend helpers for the
 * forward-test matrix scripts (init-portfolios-matrix, add-kappa-streams,
 * merge-rebalances, backseed-kappa).
 * ─────────────────────────────────────────────────────────────────────────────
 * The forward test is a methodology matrix crossed with a κ axis:
 *   300 streams = 10 configs × 6 variants × 5 κ.
 *   config  = pert (legacy PERT, BL off) + BL × prior{cap,shrunk,equal} × τ{0.01,0.03,0.10}
 *   variant = max-sharpe, min-var, tail-10/20/35/50
 *   κ       = 0, 0.1, 0.25, 0.5, 0.75  (turnover penalty; κ=0 = full rebalance)
 *   id      = `<base>@<configTag>`         for κ=0  (unchanged, reuses existing ids)
 *             `<base>@<configTag>-k<KK>`    for κ>0  (KK = round(κ·100): k10/k25/k50/k75)
 *
 * κ is realized as a POST-HOC BLEND toward drift (NOT integrated into the
 * optimizer). The optimizer emits only the κ=0 target weights; the κ>0 rows are
 * derived here by blending each stream's κ=0 target toward its own drifted prior.
 * The blend mirrors the backtester exactly so forward-test κ means what backtest κ
 * means — see backtest-portfolio/src/backtestEngine.js: driftWeights (L198),
 * blendTowardDrift (L674), minVarTurnoverPenalized (L225).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Matrix axes ───────────────────────────────────────────────────────────────
export const PRIORS = ['cap', 'shrunk', 'equal'];
export const TAUS   = [0.01, 0.03, 0.10];
export const KAPPAS = [0, 0.1, 0.25, 0.5, 0.75];
export const BASES  = [
  { base: 'max-sharpe', label: 'Max Sharpe (Consensus)' },
  { base: 'min-var',    label: 'Min Variance' },
  { base: 'tail-10',    label: 'Tail λ=0.10' },
  { base: 'tail-20',    label: 'Tail λ=0.20' },
  { base: 'tail-35',    label: 'Tail λ=0.35' },
  { base: 'tail-50',    label: 'Tail λ=0.50' },
];

export const tauTag   = t => String(Math.round(t * 100)).padStart(2, '0');       // 0.03 → '03'
export const kappaTag = k => `k${String(Math.round(k * 100)).padStart(2, '0')}`; // 0.25 → 'k25'

// configs: pert first, then BL × prior × τ
export const CONFIGS = [
  { methodology: 'pert', prior: null, tau: null, tag: 'pert' },
  ...PRIORS.flatMap(prior => TAUS.map(tau => ({
    methodology: 'bl', prior, tau, tag: `bl-${prior}-t${tauTag(tau)}`,
  }))),
];

/** Stream id: `<base>@<tag>` for κ=0 (unchanged), `<base>@<tag>-k<KK>` for κ>0. */
export const streamId = (base, tag, kappa) =>
  kappa === 0 ? `${base}@${tag}` : `${base}@${tag}-${kappaTag(kappa)}`;

/** Full 300-stream skeleton objects (10 configs × 6 variants × 5 κ). */
export function buildMatrix() {
  return CONFIGS.flatMap(c =>
    BASES.flatMap(b =>
      KAPPAS.map(kappa => ({
        id: streamId(b.base, c.tag, kappa),
        base: b.base,
        methodology: c.methodology,
        prior: c.prior,
        tau: c.tau,
        kappa,
        label: b.label,
        rebalances: [],
      }))
    )
  );
}

// ── κ blend (mirrors backtest-portfolio/src/backtestEngine.js) ────────────────
/** Drift target weights by one period's realized asset returns → pre-rebalance weights (L198). */
export function driftWeights(wTarget, rVec) {
  const grown = wTarget.map((w, k) => w * (1 + (rVec[k] ?? 0)));
  const s = grown.reduce((a, v) => a + v, 0);
  return s > 1e-12 ? grown.map(v => v / s) : wTarget.slice();
}

/** Partial-rebalance blend: (1−a)·target + a·drift, a = clamp(κ, 0, 0.95) (L674/L225). */
export function blendTowardDrift(target, driftedPrior, kappa) {
  const a = Math.min(Math.max(kappa, 0), 0.95); // clamp; never fully freeze
  return target.map((x, k) => (1 - a) * x + a * (driftedPrior[k] ?? 0));
}

/**
 * adjClose on the last settled date ≤ `date` (dates ascending). Effective dates can
 * be non-trading days (e.g. Sundays), so we take the last close on-or-before — the
 * same convention the dashboard's weightsAtDate uses (`r.effective <= barDate`).
 */
export function priceOnOrBefore(ph, date) {
  if (!ph?.dates?.length) return null;
  let px = null;
  for (let i = 0; i < ph.dates.length; i++) {
    if (ph.dates[i] <= date) px = ph.adjClose[i]; else break;
  }
  return px;
}

/**
 * Compute the κ>0 weight map for one stream at one effective date.
 *   target       — the κ=0 weight map for this base@config at `effective`
 *   priorWeights — this κ-variant's own most-recent stored weight map (or null → first period)
 *   kappa, priceByTicker (Map ticker→priceHistory), prevEffective, effective
 * Returns a bare-ticker weight map summing to ~1 (zeros dropped). First period (no
 * prior) returns the target unchanged — byte-identical to κ=0.
 */
export function blendedWeightMap(target, priorWeights, kappa, priceByTicker, prevEffective, effective) {
  if (!priorWeights) return { ...target };
  const union = [...new Set([...Object.keys(target), ...Object.keys(priorWeights)])];
  const wTarget = union.map(t => target[t] ?? 0);
  const wPrev   = union.map(t => priorWeights[t] ?? 0);
  const rVec = union.map(t => {
    const ph = priceByTicker.get(t);
    const p0 = priceOnOrBefore(ph, prevEffective);
    const p1 = priceOnOrBefore(ph, effective);
    return (p0 > 0 && p1 > 0) ? p1 / p0 - 1 : 0; // missing price → 0 return (drift = hold)
  });
  const drifted = driftWeights(wPrev, rVec);
  const blended = blendTowardDrift(wTarget, drifted, kappa);
  const s = blended.reduce((a, v) => a + v, 0) || 1;
  const out = {};
  union.forEach((t, i) => {
    const w = Math.round((blended[i] / s) * 10000) / 10000;
    if (w > 0) out[t] = w;
  });
  // fold rounding residual into the largest weight so the map sums to exactly 1
  const keys = Object.keys(out);
  const sum = keys.reduce((a, t) => a + out[t], 0);
  const residual = +(1 - sum).toFixed(4);
  if (residual !== 0 && keys.length) {
    const maxKey = keys.reduce((m, t) => (out[t] > out[m] ? t : m), keys[0]);
    out[maxKey] = +(out[maxKey] + residual).toFixed(4);
  }
  return out;
}

/** Build a ticker→priceHistory Map from a lean snapshot object (or {} if unavailable). */
export function priceMapFromSnapshot(snap) {
  const m = new Map();
  for (const a of snap?.assets ?? []) m.set(a.ticker, a.priceHistory);
  return m;
}
