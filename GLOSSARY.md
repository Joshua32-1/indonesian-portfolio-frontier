# GLOSSARY.md

Quant and IDX terms used across this repo. Each entry: a one-line definition and where it shows up in code.

- **ADT (Average Daily Turnover)** — IDR traded per day; drives liquidity position caps and the Σ penalty. → `meta.avgDailyTurnover`, `qualityFactors.js`.
- **Annualization** — scaling a short-horizon statistic to one year: daily σ × √252, weekly σ × √52. → `SQRT_252`, `matrixEngine.js`.
- **Active risk** — annualized volatility of (portfolio − benchmark) returns; tracking error vs. IHSG. → `computeBenchmarkMetrics`, `benchmarkMetrics.js`.
- **Beta (β)** — sensitivity of portfolio returns to IHSG returns. → `benchmarkMetrics.js`.
- **Beta-PERT** — a bounded distribution over `[low, mean, high]` (mean `(low+4·mode+high)/6`); used to sample analyst price targets. → `buildScenarioBank`, `monteCarlo.js`.
- **BI-Rate** — Bank Indonesia policy rate, the risk-free rate `r_f`; live-fetched, fallback 5.75%. → `fetch-snapshot.js`, `riskFreeRate` in snapshot.
- **Black-Litterman (BL)** — blends a market-equilibrium prior (π) with subjective views (Q) into posterior expected returns μ_BL. → `blackLitterman.js`.
- **Cap-weight prior (π)** — equilibrium expected returns implied by market-cap weights: `π = Δ·Σ·w_cap`. → `computeEquilibriumReturns`.
- **Cholesky decomposition** — factor `Σ = L·Lᵀ`; `L` generates correlated random shocks. → `choleskyDecompose`, `drawCorrelatedShocks`.
- **Consensus portfolio (◎)** — implementable max-Sharpe allocation on the mean (BL/PERT) returns. → `monteCarlo.js`.
- **Correlation (ρ, Pearson)** — pairwise co-movement of weekly log-returns over the chosen window. → `computeCorrelationFromDateRange`.
- **Covariance matrix (Σ)** — `Σ_ij = ρ_ij · σ_i,ann · σ_j,ann`, optionally shrunk. → `computeCovarianceMatrix`.
- **CVaR (Conditional Value-at-Risk, 5%)** — mean of the worst 5% of simulated returns; the tail-risk measure penalized by the objective. → `computeTailMetrics`.
- **Dispersion** — analyst disagreement `(high − low)/mean`; feeds BL view uncertainty Ω. → `computeDispersion`, `returns.js`.
- **Efficient frontier** — the risk/return scatter of optimal portfolios; here a Monte Carlo cloud plus the four labeled portfolios. → `EfficientFrontier.jsx`.
- **IHSG (Jakarta Composite Index)** — the IDX broad-market benchmark; Yahoo ticker `^JKSE`. → `benchmark` in snapshot.
- **`.JK`** — Yahoo suffix for IDX-listed tickers (`BBCA.JK`), used only when *querying* Yahoo. Both snapshots, the dashboard, and `portfolios.json` store the bare symbol (`BBCA`).
- **Ledoit-Wolf shrinkage** — pulls the sample covariance toward a scaled identity to reduce estimation noise; on by default. The intensity is a *heuristic* (not the formal Ledoit-Wolf estimator); the name is historical. → `ledoitWolfShrinkage`.
- **Liquidity penalty ramp** — diagonal inflation `0.9·(1 − e^(−7.5·stress))` raising the apparent risk of thinly-traded names. → `LIQ_PENALTY_CAP`, `LIQ_PENALTY_K`.
- **Methodology matrix** — the forward test's 300 live streams = 10 configs × 6 variants × 5 κ. Config = `pert` (legacy PERT) + BL × prior{cap,shrunk,equal} × τ{0.01,0.03,0.10}; κ = turnover penalty {0,0.1,0.25,0.5,0.75}; stream id = `<base>@<configTag>` (κ=0) or `<base>@<configTag>-k<KK>` (κ>0). → `portfolios.json`, [FORWARD-TEST.md](FORWARD-TEST.md).
- **Min-variance portfolio (◆)** — lowest portfolio variance subject to constraints. → `monteCarlo.js`.
- **Monte Carlo** — repeated random sampling of return scenarios (default 100k paths) to evaluate portfolios. → `runMonteCarloSimulation`.
- **Omega (Ω)** — BL view-uncertainty matrix (diagonal); larger Ω = less trust in analyst views. `omegaScale` is hardcoded at 0.05. → `computeViewUncertainty`.
- **Oracle Sharpe portfolio (▲)** — highest Sharpe across scenario optima; a hindsight ceiling, **not investable**. → `monteCarlo.js`.
- **Prior mode** — which equilibrium prior the BL blend anchors to: `cap` (market-cap, identity/default), `equal` (1/n), or `shrunk` (0.5·cap + 0.5·equal). → `applyPriorMode`, `blackLitterman.js`.
- **Risk contribution** — each asset's share of total portfolio risk (sums to 1). → `computeRiskContributions`.
- **Robust portfolio (★)** — the tail-aware fixed allocation; the recommended implementable output. → `monteCarlo.js`.
- **Sharpe ratio** — `(μ_p − r_f)/σ_p`, excess return per unit of risk. → `sharpeRatio`.
- **Stitched index** — a continuously-compounding performance index that never resets on rebalance. → `buildTrackerSeries`, dashboard.
- **Tail gap** — `E[r] − CVaR₅%`; the quantity scaled by λ in the objective. → `computeTailMetrics`.
- **Tail penalty (λ)** — weight on tail risk in the objective; default 0.10. Higher λ = more downside-averse. → `DEFAULT_TAIL_PENALTY`.
- **Tau (τ)** — BL prior-anchor strength; default 0.03 (low τ trusts the cap-weight equilibrium). → `factorConfig.js`.
- **Theta-decay** — exponential time-weighting of returns (half-life 63 trading days) so recent data dominates the vol estimate. → `thetaDecayWeight`.
- **Turnover (κ)** — one-way trade volume between current and target weights. Two uses: (1) an optional cost in the *optimizer's* objective (default off), and (2) the forward test's 5th matrix axis {0,0.1,0.25,0.5,0.75}, realized **post-hoc** by blending each stream's κ=0 target toward its own drifted prior (mirrors the backtester's `blendTowardDrift`). → `computeTurnover`, `live-dashboard-portfolio/scripts/lib/kappaExpand.mjs`.
