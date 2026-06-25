# API.md

This project has **no HTTP backend**. "API" here means the three contracts that hold the system together:

1. The **runtime data contract** — the snapshot JSON each app fetches at load.
2. The **`portfolios.json` contract** — the hand-maintained weight history the dashboard reads.
3. The **public math-module API** — the exported functions in `portfolio-app/src/math/` that the UI, the dashboard, and the validation suite depend on.

Plus the **external APIs consumed at build time** (Yahoo Finance, Bank Indonesia).

---

## 1. Runtime data contract: `live-market-snapshot.json`

Served as a static asset. In `portfolio-app`, Vite's `publicDir: 'data'` exposes it at `GET /live-market-snapshot.json`; the app fetches it on mount. Two variants exist with the **same top-level shape** but different richness:

| Variant | Path | Size | Interval | Built by |
|---------|------|------|----------|----------|
| Rich (optimizer) | `portfolio-app/data/live-market-snapshot.json` | ~1 MB | weekly history (2011→) + 252-day daily returns | `data/fetch-snapshot.js` |
| Lean (dashboard) | `live-dashboard-portfolio/data/live-market-snapshot.json` | ~14 KB | daily adjusted closes, recent ~400 calendar days | `scripts/fetch-daily-snapshot.mjs` (CI) |

### Rich schema (optimizer)

```jsonc
{
  "generated": "2026-06-22T11:41:15.995Z",   // ISO timestamp of fetch
  "description": "IDX Large-Cap Live Snapshot — fetched from Yahoo Finance v3",
  "riskFreeRate": 0.0575,                      // BI-Rate (decimal); fallback 0.0575
  "historyRange": { "start": "2011-01-01", "end": "2026-06-19", "interval": "1wk" },

  "benchmark": {
    "ticker": "IHSG",
    "yahooTicker": "^JKSE",
    "priceHistory": { "interval": "1wk", "dates": ["2011-01-07", ...], "adjClose": [3500.1, ...] }
  },

  "assets": [
    {
      "ticker": "BBCA.JK",                     // Yahoo symbol (.JK suffix)
      "name": "Bank Central Asia",
      "sector": "Banks",                       // Yahoo industry label (finer than GICS)
      "meta": {
        "currentPrice": 9200.0,
        "dividendYield": 0.035,                // decimal; default 0
        "marketCap": 1.2e13,                   // IDR
        "averageVolume": 5000000,
        "floatShares": 1000000000,
        "sharesOutstanding": 1200000000,
        "avgDailyTurnover": 4.6e13,            // IDR — drives liquidity caps/penalty
        "freeFloatPct": 0.68,
        "dailyReturns": [0.004, -0.002, ...],  // ~252 trading days; for vol recompute
        "recentDailyVol": 0.0132,              // theta-decayed σ at default half-life
        "volHalfLife": 63                      // trading days
      },
      "forwardEstimates": {                    // analyst 12-month targets
        "lowTarget": 9500.0,
        "meanTarget": 10800.0,
        "highTarget": 12000.0,
        "totalAnalysts": 24
      },
      "priceHistory": { "interval": "1wk", "dates": [...], "adjClose": [...] }
    }
    // ... one entry per ticker in the TICKERS list
  ]
}
```

### Lean schema (dashboard)

Same top level (`generated`, `benchmark`, `assets[]`) but each asset carries only `ticker` + daily `priceHistory` (`{ dates, adjClose }`); no `meta`/`forwardEstimates`. Tickers here are **bare** (`BBCA`), not `.JK`.

**Consumers must tolerate nulls:** the dashboard fetch drops bars where `adjClose` is null, and Yahoo lags 1–2 sessions before finalizing adjusted closes.

---

## 2. `portfolios.json`

Path: `live-dashboard-portfolio/data/portfolios.json`. **Manually maintained, append-only.** The dashboard reads it to build stitched index series.

```jsonc
{
  "inception": "2026-06-08",     // index base date (value = 100 here)
  "updated":   "2026-06-09",     // bump to today on every edit
  "portfolios": [
    {
      "id": "max-sharpe",                  // unique slug; colour mapped in src/App.jsx COLORS
      "label": "Max Sharpe (Consensus)",
      "rebalances": [                      // sorted ascending by effective; NEVER overwrite past rows
        { "effective": "2026-06-08", "weights": { "BBCA": 0.09, "BBRI": 0.06, ... },
          "views": "view-history/views-2026-06-05.json" }   // optional; see §3a (κ-replay)
      ]
    }
    // current ids: max-sharpe, min-var, tail-10, tail-20, tail-35, tail-50
  ]
}
```

**Rules** (enforced by convention + a red TOTAL row in the UI):
- Weights are **fractions** (0.09 = 9%) and must sum to ≈ 1.00 per rebalance entry.
- Tickers are **bare symbols** (`BBCA`), matching the lean snapshot — *not* `BBCA.JK`.
- A new `effective` row only changes the line's **future** slope; past index values are unchanged (stitched compounding — see [ARCHITECTURE.md](ARCHITECTURE.md)).
- Use the [`rebalance-portfolio`](.claude/skills/rebalance-portfolio/SKILL.md) skill to append entries safely, and the [`data-pipeline-checker`](.claude/agents/data-pipeline-checker.md) agent to validate this contract after edits.
- **`views`** (optional): a reference to the point-in-time analyst-view capture for that rebalance — see §3a.

---

## 3a. `view-history/` — point-in-time analyst views (for κ-replay)

Path: `portfolio-app/data/view-history/views-YYYY-MM-DD.json`. Written automatically by `fetch-snapshot` (locally on `npm run dev`, and weekly by the `Capture Analyst Views` GitHub Action), keyed by the snapshot's weekly-data end date — **one file per week**.

**Why:** the optimizer's weights depend on inputs that, except for prices, are *not reconstructible after the fact* — chiefly the analyst price targets (`forwardEstimates`), plus slowly-varying caps / dividend yield / BI-rate. Prices for any past date come from [`backtest-portfolio/public/backtest-history.json`](backtest-portfolio/public/backtest-history.json), so we archive only the non-reconstructible bits. This is the data a future **κ-replay** (or λ-replay) of the *live, signal-driven* strategy needs — recompute Σ from prices, μ/views + caps + rf from the weekly capture, and re-run the optimizer (`optimizeTailAware`/`walkVariant`) at any turnover penalty.

**Trimmed schema (~5–10 KB):**
```jsonc
{
  "asOf": "2026-06-05",            // = the snapshot's weeklyEnd
  "generated": "2026-06-08T…Z",
  "riskFreeRate": 0.0575,          // BI-rate at capture
  "assets": [
    { "ticker": "BBCA",
      "currentPrice": 9800,
      "dividendYield": 0.038,
      "marketCap": 1.2e15,
      "sharesOutstanding": 1.23e11,
      "forwardEstimates": { "lowTarget": 9000, "meanTarget": 11500, "highTarget": 13000, "totalAnalysts": 32 } }
    // … one per ticker
  ]
}
```
Capturing **weekly** (not just at each rebalance) keeps the *finest* replay grid open even though trades happen monthly/quarterly. Inception rows in `portfolios.json` predate capture and have no `views` link.

---

## 3. External APIs (build-time only — never called at runtime)

| Source | Used by | What it provides |
|--------|---------|------------------|
| **Yahoo Finance v3** (`yahoo-finance2` npm) | both fetch scripts | weekly/daily `chart()` price history; `quoteSummary` modules: `financialData`, `summaryDetail`, `defaultKeyStatistics`, `assetProfile`, `summaryProfile` |
| **Bank Indonesia BI-Rate** page | `portfolio-app/data/fetch-snapshot.js` | risk-free rate, scraped from `https://www.bi.go.id/en/statistik/indikator/bi-rate.aspx`; validated to `[BI_RATE_MIN=0.01, BI_RATE_MAX=0.15]`, else `BI_RATE_FALLBACK=0.0575` |

The dashboard's daily fetch uses Yahoo `chart()` (not `historical()`) to avoid errors on unsettled recent bars.

---

## 4. Public math-module API (`portfolio-app/src/math/`)

Pure functions; this is the contract the UI, the validation suite, and (for the shared helpers) the dashboard rely on. Signatures below are verified against source. For derivations and formulas see [portfolio-app/README.md](portfolio-app/README.md); for the assumptions behind the numbers see [ASSUMPTIONS.md](ASSUMPTIONS.md).

### `matrixEngine.js` — correlation, covariance, portfolio metrics

| Constant | Value |
|----------|-------|
| `SQRT_252` | √252 ≈ 15.874 |
| `VOL_LOOKBACK_DAYS` | 252 |
| `DEFAULT_VOL_HALF_LIFE` | 63 (trading days) |
| `FALLBACK_DAILY_VOL` | 0.015 |
| `MIN_CORR_OBS` | 20 (weekly obs; window auto-expands below this) |

| Function | Purpose |
|----------|---------|
| `canonicalWeeklyKey(isoDate)` | Normalize weekly bars to canonical week keys (handles odd anchors) |
| `commonPriceDates(histories)` | Intersection of canonical weeks across series |
| `alignPriceSeries(series)` | Aligned close-price rows on common weeks |
| `logReturnsFromPrices(prices)` | Log-returns, oldest → newest |
| `computeCorrelationFromDateRange(assets, startISO, endISO)` | Pearson ρ matrix → `{ matrix, labels, obs }` |
| `buildIndexedChartData(assets, benchmarkHistory, chartStartISO, chartEndISO)` | Rebased-to-100 chart rows |
| `availableHistoryRange(assets, benchmarkHistory)` / `alignedHistoryRange(assets, benchmarkHistory?)` | Union / intersection date ranges |
| `todayISO()` | Local date `YYYY-MM-DD` |
| `thetaDecayWeight(ageDays, halfLifeDays)` | `0.5^(age/halfLife)` |
| `computeThetaDecayedVol(dailyReturns, halfLifeDays?)` | Theta-decayed daily σ (default half-life 63; fallback 1.5%) |
| `resolveDailyVol(asset, halfLifeDays?)` | Computed vol, else snapshot value |
| `ledoitWolfShrinkage(S, nObs)` | Analytical shrinkage toward scaled identity |
| `computeCovarianceMatrix(corrMatrix, assets, { volHalfLife, shrinkage, nObs })` | Σ from ρ and annualized σ → `{ covMatrix, ... }` |
| `augmentCovarianceMatrix(covMatrix, perAssetFactors, factorConfig)` | Adds liquidity penalty to Σ diagonal |
| `empiricalQuantile(sorted, p)` | Hyndman-Fan type 7 quantile |
| `portfolioReturn(weights, means)` / `portfolioVariance(weights, covMatrix)` | `w·μ` / `wᵀΣw` |
| `sharpeRatio(ret, risk, rf=0.0575)` / `reconcilePortfolioSharpe(portfolio, rf=0.0575)` | Sharpe |
| `computeRiskContributions(weights, covMatrix)` | Per-asset risk-contribution fractions (sum to 1) |
| `choleskyDecompose(covMatrix)` | Lower-triangular L for correlated shocks |

### `monteCarlo.js` — scenario generation & optimization

| Function | Purpose |
|----------|---------|
| `buildScenarioBank({ assets, iterations, factorConfig, covMatrix, riskFreeRate, ... })` | N Monte Carlo analyst-return vectors; applies BL blend if enabled |
| `runMonteCarloSimulation({ assets, covMatrix, riskFreeRate, iterations, factorConfig, robustMode, tailPenalty, ... })` | **Main entry.** Returns the 4 labeled portfolios (robust ★, oracle ▲, min-var ◆, consensus ◎), efficient-frontier cloud, λ frontier, stress + benchmark metrics |
| `evaluateStressScenarios(assets, weights)` | Stress tests on analyst extremes / shocks |

### `blackLitterman.js` — posterior returns with analyst views

| Function | Purpose |
|----------|---------|
| `defaultDelta(covMatrix, capWeights, riskFreeRate)` | Implied risk aversion Δ from cap-weight equilibrium |
| `computeEquilibriumReturns(covMatrix, capWeights, { riskFreeRate=0.0575, delta=null })` | Prior π = Δ·Σ·w_cap |
| `computeViewUncertainty(assets, covMatrix, factorConfig, maxAnalysts)` | View uncertainty Ω diagonal |
| `blackLittermanPosterior({ pi, Q, omega, covMatrix, tau })` | Posterior μ_BL |
| `buildBlackLittermanContext({ ... })` | Pre-compute π, Ω for a run |
| `computePosteriorReturns(Q, covMatrix, blContext)` | μ_BL from views Q given a prebuilt context |
| `shouldUseBlackLitterman(factorConfig)` | `useBlackLitterman && useCapPrior && useAnalystViews` |

### `qualityFactors.js` — factor scores & liquidity

| Constant | Value |
|----------|-------|
| `LIQ_PENALTY_CAP` | 0.9 (max diagonal inflation) |
| `LIQ_PENALTY_K` | 7.5 (ramp steepness) |

| Function | Purpose |
|----------|---------|
| `impliedReturnFromTarget(asset, targetPrice)` | `(target − current)/current + dividend` |
| `meanViewReturn(asset)` | Q_i from analyst mean target |
| `computeQualityFactors(assets, factorConfig)` | Per-asset factor scores, cap weights |
| `computeAutoLiquidityCaps(assets, portfolioSize, maxPositionCap=1)` | ADT-based position caps |
| `resolvePortfolioLiquidity(assets, factorConfig, maxPositionCap=1)` | Portfolio stress ratio |
| `computeFactorPreview(assets, covMatrix, factorConfig, maxPositionCap, riskFreeRate, userPositionCaps={})` | Test-run factors (used by validation) |

### `robustObjective.js` — tail-aware objective & turnover

| Constant | Value |
|----------|-------|
| `ROBUST_SUBSAMPLE_SIZE` | 1000 (paths fed to optimizer) |

| Function | Purpose |
|----------|---------|
| `drawCorrelatedShocks(choleskyL, nPaths)` | Cholesky-based correlated shocks (reused across λ sweep) |
| `pickEvenlySpacedIndices(total, count)` | Deterministic subsampling |
| `covDiag(covMatrix)` | Diagonal (per-asset variance) |
| `realizedSimpleReturn(mu, shock, varDiag)` | Lognormal 1-yr return with Ito correction |
| `computeRealizedPortfolioReturns(weights, scenarios, shockMatrix, sigDiag)` | Portfolio returns across paths |
| `computeTailMetrics(returns, riskFreeRate)` | CVaR₅%, tail gap, P(below r_f) |
| `buildObjectiveFn({ mode, subsampleScenarios, avgMeans, covMatrix, rf, lambda, ... })` | Objective for the optimizer |
| `computeTurnover(wTarget, wCurrent)` | One-way turnover |
| `buildRebalanceTrades(assets, targetWeights, currentWeights)` | Current vs. proposed trades |

### `benchmarkMetrics.js`, `returns.js`, `sectorCaps.js`, `assetSector.js`

| Function | Purpose |
|----------|---------|
| `computeBenchmarkMetrics(assets, weights, benchmarkHistory, startISO, endISO)` | IHSG beta, correlation, active risk (read-only diagnostics) |
| `dividendYield(asset)` / `hasDividend(asset)` | Dividend helpers |
| `priceUpsideDecimal(currentPrice, targetPrice)` / `totalUpsideDecimal(currentPrice, targetPrice, yieldDecimal=0)` | Upside |
| `consensusTotalUpside(asset)` / `fmtUpsidePct(decimal)` / `computeDispersion(asset)` | Consensus upside, formatting, analyst dispersion |
| `DEFAULT_SECTOR_CAP=0.80`, `MIN_SECTOR_CAP=0.05` | Sector limits |
| `resolveSectorCap`, `buildSectorCapsForSectors`, `hasBindingSectorCaps`, `computeSectorWeights`, `mergePositionCaps` | Sector/position cap logic |
| `resolveSectorFromQuoteSummary(summary)` | Industry label from Yahoo profile; fallback `'Other'` |

### Config: `factorConfig.js`, `simConfig.js`

`DEFAULT_FACTOR_CONFIG` (BL/factor model): `useFactorModel:false`, `useBlackLitterman:true`, `useCapPrior:true`, `useAnalystViews:true`, `tau:0.03`, `omegaScale:0.05`, `analystConfidence:0.7`, `dispersionOmega:0.8`, `largeCapBias:0.25`, `useLiquidityRisk:true`, `portfolioSize:0`. Helpers: `normalizeFactorConfig`, `isFactorModelActive`, `formatFactorConfigSummary`.

`DEFAULT_SIM_CONFIG`: `robustMode:'tailAware'`, `tailPenalty:0.10` (`DEFAULT_TAIL_PENALTY`), `turnoverPenalty:0`, `shrinkage:true`, `optimizerPaths:1000`, `deterministicStarts:true`.

### Dashboard math: `live-dashboard-portfolio/src/math/`

| Function (`portfolioIndex.js`) | Purpose |
|--------------------------------|---------|
| `weightsAtDate(rebalances, barDate)` | Active weight set on/before a date |
| `buildTrackerSeries(portfolio, assets, benchmarkHistory, inception)` | Stitched index series (base 100), compounds continuously |
| `buildIHSGSeries(benchmarkHistory, inception)` | IHSG index series (base 100) |
| `mergeChartRows(allSeries)` | Merge into Recharts row format |
| `sinceInceptionReturn(series)` | Decimal return since inception |
| `latestRebalanceDate(rebalances)` / `latestWeights(portfolio)` | Latest entry helpers |

`priceAlign.js` provides `alignPriceSeries` (date alignment) used by the above.
