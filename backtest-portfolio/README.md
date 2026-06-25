# IDX Walk-Forward Backtest

A look-ahead-free, cost-aware walk-forward backtest of the optimizer's **construction machinery** on the IDX large-cap universe. It answers one honest question:

> Does the BL-equilibrium + tail-aware/CVaR + Ledoit-Wolf risk machinery beat naive baselines (min-variance, equal-weight, IHSG) out-of-sample, **net of realistic Indonesian transaction costs**?

## What this does and does NOT test

The optimizer's edge has three layers. Only two are backtestable here:

| Layer | Backtestable? | Validated by |
|-------|---------------|--------------|
| **Risk machinery** — trailing ρ + theta-decay σ + Ledoit-Wolf Σ | ✅ | this backtest |
| **Structure** — BL-equilibrium prior, tail-aware/CVaR objective, constraints | ✅ | this backtest |
| **Alpha signal** — analyst price-target views (PERT → BL posterior) | ❌ | the **live forward-test** |

The analyst-target signal **cannot be historicized** — only today's targets exist in the snapshot, so applying them to the past would be look-ahead. The backtest therefore runs **machinery-only**: the tail-aware objective is driven by an empirical, equilibrium-centered return distribution with the trailing covariance, not by analyst views.

**The alpha signal is instead validated forward**, by the live dashboard (`live-dashboard-portfolio/`), which began tracking on **2026-06-29**. Point-in-time analyst snapshots are now archived (`portfolio-app/data/archive/`) so a *true* full-strategy retro-backtest becomes possible once enough history accumulates.

## Commands

```bash
npm run fetch       # node scripts/fetch-backtest-history.mjs — full daily+weekly history,
                    #   dollar-volume (liquidity) and shares-outstanding per name, + IHSG
npm run backtest    # node scripts/run-strategy-backtest.mjs — precompute the tail-aware
                    #   strategy backtest (κ + frequency sweep) → public/backtest-results.json
npm run dev         # Vite dev server; renders the precomputed strategy panel + a live
                    #   min-variance explorer that recomputes as you toggle the universe
```

The strategy backtest optimizes the production objective per rebalance × per κ × per frequency — too heavy to recompute live — so it is **precomputed** to `public/backtest-results.json` and rendered statically. The lightweight min-variance/equal-weight/IHSG comparison stays live for universe exploration.

## Transaction-cost model

Costs are charged on **drift-adjusted turnover** (the book is moved from drifted prior weights to new targets):

- **Half-spread** from trailing average daily value (liquidity): `clamp(K/√ADV_bn, 5 bps, 50 bps)`.
- **Brokerage**, asymmetric: buy ≈ **0.15%**, sell ≈ **0.25%** (the sell leg carries the IDX transaction levy + final tax).
- A **flat per-side fallback** (~35 bps) applies when a snapshot predates the dollar-volume field.

All headline curves and metrics are **net of costs**; gross Sharpe is shown alongside so the drag is explicit. Constants live in `COST` in [src/backtestEngine.js](src/backtestEngine.js).

## Reported statistics

Net-of-cost, vs IHSG: annualized return/vol, Sharpe (net + gross), max drawdown, **Information Ratio**, **t-stat of alpha** (≈ IR·√years), **hit rate**, tracking error, beta, **annual turnover**, and **annual cost drag**.

## Limitations

- Machinery-only (no analyst signal — see above).
- Survivorship bias: the universe is the currently-liquid IDX large-caps.
- Cap-weight approximation: the equilibrium prior uses current shares-outstanding (Yahoo exposes no history) × point-in-time price.
- Sample length: even ~15 years of weekly data gives limited statistical power; read the t-stat with appropriate humility.
