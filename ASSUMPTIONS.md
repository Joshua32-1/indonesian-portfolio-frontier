# ASSUMPTIONS.md

> Read this before trusting any number the optimizer or dashboard produces. The output reflects a chain of modeling choices and IDX-specific calibration. None of it is investment advice.

## Market data

- **Single source:** all prices come from Yahoo Finance v3 (`yahoo-finance2`). No reconciliation against a second vendor.
- **Weekly bars since 2011** for correlation/history (`FULL_HISTORY = { start: '2011-01-01', interval: '1wk' }`); **daily bars (~last 252 trading days)** for volatility.
- **Last completed bar only:** the fetch drops the in-progress week/day and any bar with a null adjusted close. Yahoo lags 1–2 sessions before adjusted closes finalize.
- **Canonical week keys:** weekly bars are normalized so assets with odd anchoring (e.g. a Sunday-dated bar) align to the same week as the rest (`canonicalWeeklyKey` in `matrixEngine.js`).
- **Fixed ticker universe** (25 IDX large-caps, `.JK`) defined once in `portfolio-app/data/universe.js` (`UNIVERSE_JK`) and imported by all three apps' fetch scripts. This introduces **survivorship bias** — delisted/merged names are not represented, and the list is not point-in-time. (The dashboard fetch additionally unions in any ticker still held in `portfolios.json`, so a removed name keeps being tracked, but the optimizer/backtest universe is the canonical list.)
- **Minimum observations:** correlation needs ≥ `MIN_CORR_OBS = 20` weekly observations; the window auto-expands if too short.

## Risk-free rate

- `r_f` = **Bank Indonesia BI-Rate**, scraped live at snapshot time, validated to `[1%, 15%]`, else **fallback 5.75%** (`BI_RATE_FALLBACK`).
- The same `r_f` is used for Sharpe, the BL equilibrium, and the "probability below risk-free" tail metric.

## Annualization

- Daily volatility → annual: `× √252`. Weekly → annual: `× √52`. **252 trading days/year.**
- Covariance is built from annualized σ and the correlation matrix: `Σ_ij = ρ_ij · σ_i,ann · σ_j,ann`.

## Expected-returns model

- Analyst 12-month price targets (`low / mean / high`) drive expected return.
- **Beta-PERT sampling** over `[low, mean, high]`: mean `(low + 4·mode + high)/6`. Each Monte Carlo path draws a target, converts to return `(sampled − current)/current + dividendYield`.
- One-year **realized** returns are **lognormal with an Ito correction** (`realizedSimpleReturn` in `robustObjective.js`), not simple normal returns.
- Dividends added as a flat simple yield from `meta.dividendYield` (default 0). No dividend growth, no reinvestment timing.

## Black-Litterman & IDX calibration

The factor model (`useFactorModel`) is **off by default** (the optimizer-config default is still legacy PERT); when on, BL blends an equilibrium prior with analyst views. The forward-test matrix turns it on per-run via `optimize.mjs --methodology bl`. Key calibration, from `factorConfig.js`:

- **Structural sell-side optimism:** IDX analyst 12-month targets average **~50 percentage points above** the cap-weight equilibrium π (gap ≈ 1.5× annualized σ). The model is tuned to discount this, not take it at face value.
- **`tau = 0.03`** (conservative default): low τ anchors the posterior toward the equilibrium prior π; higher τ would trust analyst targets more. τ is **no longer a fixed constant** for the forward test — `optimize.mjs --tau` overrides it (the matrix sweeps τ ∈ {0.01, 0.03, 0.10}).
- **Equilibrium prior is selectable** (`applyPriorMode`, default `cap`): `cap` = market-cap equilibrium (identity, unchanged), `equal` = 1/n, `shrunk` = 0.5·cap + 0.5·equal. The matrix sweeps all three (`--prior-mode`).
- **`omegaScale = 0.05`** is **hardcoded, not a UI slider.** The academic RMSE-implied value (~0.61) would effectively ignore analyst views entirely; 0.05 is the practical BL convention that keeps meaningful per-stock signal. It yields ~48% shrinkage for a heavily-covered large-cap (BBCA, 24 analysts) and ~83% for a thin speculative name.
- Per-stock differentiation comes from `analystConfidence` (0.7) and `dispersionOmega` (0.8), not from `omegaScale`.
- `largeCapBias = 0.25` sets the cap-weight exponent `1 − 2·bias` (0.5 at the default) — **raising it flattens** the equilibrium away from mega-caps toward smaller names (0 = pure cap-weight, 0.5 = equal-weight).

## Volatility

- **Theta-decayed** daily volatility: exponential weighting with **half-life 63 trading days** (~1 quarter), recomputed from `meta.dailyReturns`. UI exposes the half-life as a slider.
- **Fallback 1.5% daily** when history is too short (`FALLBACK_DAILY_VOL`).
- **Covariance shrinkage** is **on by default** — Σ is shrunk toward a scaled identity with a **heuristic data-driven intensity** α ∈ [0,1] (≈0.2 on the live universe). The function is named `ledoitWolfShrinkage` for historical reasons but is *not* the formal Ledoit-Wolf estimator; it is a convex combination, so the shrunk Σ stays symmetric PSD.

## Robust objective

- Default mode **`tailAware`** with **`λ = 0.10`** (light tail penalty, near max-Sharpe). Objective:

  `maximize  Sharpe(avg μ) − λ · (tailGap / σ_ref) − κ · turnover`

  where `tailGap = E[r] − CVaR₅%`, `σ_ref` normalizes λ across universes (equal-weight portfolio standard deviation), and `κ = turnoverPenalty` (default 0, off). **This objective-integrated κ is distinct from the forward test's κ axis** — the latter is applied *post-hoc* (a blend of the κ=0 target toward the drifted prior, mirroring the backtester's `blendTowardDrift`), not inside this objective. See [FORWARD-TEST.md](FORWARD-TEST.md).
- **CVaR at the 5% level.**
- **Anti-overfit:** the optimizer hill-climbs on a **subsample of 1000 paths** (`ROBUST_SUBSAMPLE_SIZE`) drawn from the full 100k-path Monte Carlo bank; the full set is used only for reporting (the efficient-frontier cloud).
- **Deterministic starts:** cap-corner + sector-corner + analytical seeds (no Dirichlet randoms), so re-running gives stable results.
- Legacy mode `avgMuSharpe` (max-Sharpe on average scenario returns, no tail penalty) is available for comparison.

## Liquidity

- **Continuous penalty ramp:** diagonal inflation `0.9 · (1 − e^(−7.5·stress))` (`LIQ_PENALTY_CAP=0.9`, `LIQ_PENALTY_K=7.5`), where stress is an ADT-based ratio. Anchors: stress 0.05→0.28, 0.10→0.48, 0.20→0.70, 0.50→0.88.
- Position caps derive from average daily turnover (`meta.avgDailyTurnover`).
- **`portfolioSize = 0` ⇒ liquidity is ignored** (no penalty, no ADT caps). Set AUM in IDR to activate.

## Constraints

- **Long-only**, weights **sum to 1**.
- Default **sector cap 80%** (`DEFAULT_SECTOR_CAP`), minimum sector cap 5% (`MIN_SECTOR_CAP`).
- **No per-stock cap by default** (effective per-asset cap = min of global cap, liquidity cap, user override).

## Known limitations

- **Not investment advice.** A research/teaching tool.
- The browser optimizer is a **heuristic hill-climber**, not a guaranteed global optimum. The **Oracle Sharpe** portfolio is a hindsight ceiling (best Sharpe across scenario optima) — **not investable**; use Robust / Consensus for implementable allocations.
- **Survivorship bias** in the fixed ticker list (see Market data).
- **The optimizer itself has no transaction-cost model** beyond the optional turnover penalty κ; it does not net out taxes, slippage, or borrow costs when constructing weights. The companion **backtest app** (`backtest-portfolio/`) *does* apply a liquidity-aware IDX cost model when evaluating realized performance: per-asset half-spread from trailing dollar-volume (5–50 bps, `halfSpreadK/floor/ceil`) plus asymmetric brokerage (buy ≈ 0.15%, sell ≈ 0.25% incl. levy/tax), charged on drift-adjusted turnover, with a flat per-side fallback when liquidity data is absent. See `backtest-portfolio/src/backtestEngine.js` (`COST`).
- Sector labels come from Yahoo's **industry** field (finer than GICS) and can drift; `refresh-sectors` updates them.
- Analyst targets are a **12-month** horizon mapped onto a 1-year return — coverage and target staleness vary by name.

For prescriptive guidance on which knobs to change for a given universe/risk posture, see [portfolio-app/CALIBRATION.md](portfolio-app/CALIBRATION.md). For formula derivations see [portfolio-app/README.md](portfolio-app/README.md).
