# IDX Walk-Forward Backtest

A look-ahead-free, cost-aware walk-forward backtest of the optimizer's **construction machinery** on the IDX large-cap universe. It answers one honest question:

> Does the BL-equilibrium + tail-aware/CVaR + Ledoit-Wolf risk machinery beat naive baselines (min-variance, equal-weight, IHSG) out-of-sample, **net of realistic Indonesian transaction costs**?

## What this does and does NOT test

The optimizer's edge has three layers. Only two are backtestable here:

| Layer | Backtestable? | Validated by |
|-------|---------------|--------------|
| **Risk machinery** — trailing ρ + theta-decay σ + Ledoit-Wolf Σ | ✅ | this backtest |
| **Structure** — BL-equilibrium prior, tail-aware/CVaR objective, constraints | ✅ | this backtest |
| **Alpha signal** — analyst price-target views | ✅ *with `VIEWS=`* | this backtest **and** the live forward-test |

### The signal axis (`VIEWS=`)

The alpha signal used to be un-backtestable: only today's targets existed, so applying them to the past would have been look-ahead. That changed with [`portfolio-app/data/analyst-views.json`](../API.md#3b-analyst-viewsjson--the-point-in-time-target-archive-backtest-μ-signal) — a **15-year weekly archive of point-in-time 12-month consensus targets** (2011-08 → present, **86 names** — the 25 core-tier names plus the LQ45 and broad-IHSG tiers). Every lookup is strictly as-of (`date <= t`), so a 2018 rebalance sees the consensus as it stood in 2018.

μ now has **two independent axes that compose**:

| Axis | Values | What it sets |
|------|--------|--------------|
| `PRIOR=` | `cap` · `shrunk` · `equal` · `none` | the **anchor** — the BL equilibrium π reverse-optimized from reference weights, or none |
| `VIEWS=` | `off` · `analyst` · `hybrid` · `sample` | the **signal** — where each name's expected return comes from |

- `off` — no signal. μ *is* the anchor. **This is the historical default and it is a tautology worth knowing about:** max-Sharpe on π alone returns the prior weights identically, since `w ∝ Σ⁻¹(π − r_f·1) = Σ⁻¹δΣw_prior ∝ w_prior`. With `PRIOR=cap VIEWS=off`, the "Max-Sharpe" curve *is* the cap-weighted book — every tilt you see comes from the tail penalty, the caps and κ, never from μ.
- `analyst` — point-in-time targets where the archive covers a name; uncovered names stay at the anchor (ω → ∞, i.e. no opinion).
- `hybrid` — targets where available, **trailing 1-year sample mean everywhere else**, so every name always carries an expected return.
- `sample` — trailing sample mean for every name. With `PRIOR=none` this reproduces plain Markowitz exactly (and is bit-identical to `VIEWS=off PRIOR=none`, which is the regression check on the plumbing).

With an anchor, the signal enters as Black-Litterman views Q and the optimizer sees the posterior — so the BL knobs matter and are exposed: `TAU`, `OMEGA_SCALE`, `ANALYST_CONF`, `DISP_OMEGA`. Without an anchor (`PRIOR=none`), the signal is μ outright.

### Config search (`npm run sweep`)

Change the stock selection and you have changed which configuration the history supports. `sweep-configs.mjs` answers that for a given universe and prints the settings to carry back into `portfolio-app`:

```bash
UNIVERSE=BBCA,BBRI,TLKM,KLBF npm run sweep
```

It iterates **only the μ-source axes** — `PRIOR` × `VIEWS` × `TAU` — because λ, κ and rebalance frequency are already swept *inside* a single `runStrategyBacktest` call and come free. Σ is built once per frequency and shared across every config via `riskCache` (Σ costs ~34 ms/step against ~4-5 ms for an optimizer walk, so rebuilding it per config would burn about half the run).

**The ranking is out-of-sample, and it does not recommend the argmax.** Every strategy here has a t-stat around 0.1–0.3, so the single best cell out of ~60 is reliably a spike: on the reference run the top cell scored train 0.79 / test −0.11, while its own family scored a far more believable 0.62 / −0.07. So the tool recommends the best **family** — `(signal, frequency, objective)` averaged across every prior and τ — and prints the family's spread as the robustness statistic. A tight family (low sd) is a plateau you can stand on; a family carried by one member is a coincidence.

Configs are scored on the **train** slice (first 60% of the walk by date), with the **test** slice printed beside them. The split is post-hoc on one continuous walk-forward, so it introduces no look-ahead — the test slice is just the later part of the same run.

**Decay is measured against the baselines, not against zero.** Min-Var and Equal-Weight never read μ, so whatever *they* lose from train to test is the market regime changing underfoot. On the reference run every config decayed ~0.8 — and so did the baselines (0.77), making the raw decay common-mode rather than evidence of over-fitting. Only the **excess** over the baseline decay is a grid-mining signal, and that is what the tool warns on.

Read the output as **a map of where the machinery behaves sensibly for these names**, not as a setting that has been proven to win.

**Coverage is reported, never assumed.** The archive reaches **99%** of ticker-steps over the 22-name listing-cutoff universe (91% across all 25, the shortfall being late listings — AADI, NCKL, CMRY). `params.viewCoverage` carries the realized per-frequency number, and a lookup staler than `STALE_DAYS` (default 120) resolves to *no view* rather than passing off a two-year-old target as current.

**The signal is still also validated forward**, by the live dashboard (`live-dashboard-portfolio/`), which began tracking on **2026-06-30**. The two are complementary: the backtest gives length, the forward test gives a clean out-of-sample record with no survivorship or vendor-restatement risk.

## Commands

```bash
npm run fetch       # node scripts/fetch-backtest-history.mjs — full daily+weekly history,
                    #   dollar-volume (liquidity) and shares-outstanding per name, + IHSG
npm run backtest    # node scripts/run-strategy-backtest.mjs — precompute the tail-aware
                    #   strategy backtest (κ + frequency sweep) → public/backtest-results.json
VIEWS=hybrid npm run backtest        # …with the analyst signal on (see "The signal axis")
TAU=0.10 VIEWS=hybrid npm run backtest   # …and a looser BL anchor (trusts targets more)
npm run sweep       # node scripts/sweep-configs.mjs — config search for a stock selection
UNIVERSE=BBCA,BBRI,… npm run sweep       # …for the names you actually care about
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
