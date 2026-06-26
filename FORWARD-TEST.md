# Forward-Test Protocol — IDX Portfolio Tracker

Out-of-sample validation of the `portfolio-app` quant engine using live IDX price data, starting 2026-06-08.

## What is being tested

Six portfolio strategies (Max Sharpe, Min Variance, Tail λ=0.10/0.20/0.35/0.50) are tracked live against IHSG from a fixed inception date. The optimizer is re-run weekly and weights are updated in `portfolios.json`. The live dashboard (`live-dashboard-portfolio`) tracks realized compounded returns continuously and computes the forward-test metrics described below.

This is a genuine **out-of-sample** test — the optimizer was built and calibrated before 2026-06-08, and no in-sample data after that date is used to tune it.

---

## Hypotheses and success criteria

| # | Hypothesis | Success criterion | Verdict date |
|---|-----------|------------------|-------------|
| **H1** | Risk-adjusted outperformance: the optimizer produces at least one strategy with higher Sharpe than IHSG | Any strategy Sharpe > IHSG Sharpe after 12 months of live data | 2027-06-08 |
| **H2** | Tail protection: higher-λ portfolios show shallower drawdowns during IDX sell-offs | During any IHSG drawdown > 5%, both tail-35 and tail-50 max DD ≤ 70% of IHSG max DD | Rolling — first qualifying event |
| **H3** | Forecast calibration: analyst price targets (consensus-weighted by the max-sharpe portfolio) land within 15% of realized prices | \|realized_price / analyst_target − 1\| < 0.15 for the consensus-weighted basket | 2027-06-08 |

**Primary metric: H1 (Sharpe ratio)**. The dashboard's Sharpe column is the main verdict signal.

---

## Rebalance protocol — automated, every Sunday

Rebalances run **automatically** — no local optimizer run needed.

[`.github/workflows/weekly-rebalance.yml`](.github/workflows/weekly-rebalance.yml)
runs Sundays at 12:00 UTC (19:00 WIB) — the new weights become effective on Monday's
first trading bar — and:

1. Fetches a fresh optimizer snapshot (Yahoo prices, analyst targets, BI-Rate).
2. Runs [`portfolio-app/scripts/optimize.mjs`](portfolio-app/scripts/optimize.mjs)
   — the same math as the browser Analytics tab, headless — and **appends** a new
   dated rebalance to each of the six strategies in `portfolios.json`.
3. **Opens a PR** titled *"Weekly rebalance — review new weights"*.

Nothing reaches production until **you merge the PR**. Merging triggers the Vercel
redeploy; past index values never change — only the slope from the new `effective`
date forward.

### Reviewing a rebalance PR

- Read the weight diff per strategy. Large unexplained swings warrant a look at the
  snapshot (a data glitch or a stale analyst target).
- The script enforces weights sum to ≈1.00 and that every ticker exists in the
  dashboard snapshot, failing the job otherwise — so a green PR is already validated.
- **Merge** to accept, or **close** to skip that week. History stays append-only
  either way (a skipped week simply carries the prior weights forward).

### Tuning methodology

All knobs live in
[`portfolio-app/optimizer-config.json`](portfolio-app/optimizer-config.json) — MC
iterations, correlation window, sector caps, tail penalty, and the Black-Litterman
factor model. Editing it changes **all future** automated runs. Per the guardrails
below, changing methodology mid-test is deliberate: note it in this doc when you do.

### Manual / local run

Trigger from the GitHub Actions UI (*Run workflow* → optional `effective` date), or
locally to preview:

```bash
cd portfolio-app
npm run fetch-snapshot
node scripts/optimize.mjs --dry-run                          # full-fidelity preview, no write
node scripts/optimize.mjs --dry-run --iterations 2000 --paths 100   # fast smoke test
```

`optimize.mjs` flags: `--effective YYYY-MM-DD`, `--dry-run`, `--iterations N`,
`--paths N` (the last two override config for CI tuning / fast tests).

---

## Weekly snapshot refresh (automated)

The lean price snapshot (`live-dashboard-portfolio/data/live-market-snapshot.json`) is refreshed automatically by GitHub Actions on weekdays at 11:00 UTC (18:00 WIB, after IDX close). No manual action needed unless CI is broken.

To force a manual refresh:
```bash
cd live-dashboard-portfolio
npm run fetch-snapshot
git add data/live-market-snapshot.json
git commit -m "chore: manual snapshot refresh $(date +%Y-%m-%d)"
git push
```

---

## How to read the dashboard metrics

Open the live dashboard (deployed on Vercel). The **Performance Metrics** table shows one row per strategy.

| Column | What it measures | How to interpret |
|--------|----------------|-----------------|
| **Total Return** | Cumulative compounded return since 2026-06-08, indexed from 100 | Simple comparison; not risk-adjusted |
| **Ann. Return** | CAGR over the observation window | Comparable across strategies; meaningful after ~63 trading days |
| **Ann. Vol** | Daily std dev × √252 | Lower is not always better — read alongside Sharpe |
| **Sharpe** | (Ann. return − BI-Rate 5.75%) / Ann. vol | **Primary H1 metric.** > 1.0 is strong for IDX equities; > IHSG Sharpe = outperformance |
| **Max DD** | Largest peak-to-trough decline | **H2 metric.** Compare tail-10/20/35/50 values during IDX drawdowns |
| **Tracking Error** | Annualized std dev of (portfolio daily return − IHSG daily return) | Active-bet sizing; high TE = large active bets vs the index |
| **Info Ratio** | (Portfolio ann. return − IHSG ann. return) / Tracking Error | Active-bet efficiency; > 0.5 after 12 months is a reasonable target |

**Note on short-horizon noise**: Annualized metrics amplify daily noise when fewer than ~63 trading days have elapsed. A 2% move over 10 trading days annualizes to ≈ 68%. The numbers are mathematically correct but should not be read as stable estimates until ~September 2026.

---

## Checkpoint schedule

| Date | Type | Actions |
|------|------|---------|
| **2026-09-08** | 3-month diagnostic | Review the metrics table. Check for gross failures: any strategy tracking error > 40%, Sharpe below −2, or obvious data gaps. Not a verdict — just an early warning check. |
| **2027-06-08** | 12-month verdict | Evaluate H1, H2, H3 against the success criteria above. Document findings in CALIBRATION.md. |

---

## Guardrails

These rules protect the integrity of the out-of-sample test:

- **Never backfill** — do not add `rebalances[]` entries with past `effective` dates after the fact.
- **Never edit past rebalances** — the `rebalances[]` array is append-only. The dashboard's stitched index depends on this invariant.
- **Don't change the inception date** — `portfolios.json → inception: 2026-06-08` is fixed for the life of this test.
- **Don't change the λ values mid-test** — the 6 strategy variants (max-sharpe, min-var, tail-10/20/35/50) must remain fixed so the comparison is clean.
- **Don't retrain the model on post-inception data** — calibration (CALIBRATION.md) is frozen at inception. Methodology changes go through `optimizer-config.json` and must be recorded here.

---

## Quick reference

```
Inception:      2026-06-08
Strategies:     max-sharpe, min-var, tail-10, tail-20, tail-35, tail-50
BI-Rate (rf):   5.75% (portfolios.json → riskFreeRate: 0.0575)
Rebalance:      Automated weekly PR, Sundays 12:00 UTC via .github/workflows/weekly-rebalance.yml
CI snapshot:    Weekdays 11:00 UTC (18:00 WIB) via .github/workflows/refresh-dashboard.yml
Optimizer cfg:  portfolio-app/optimizer-config.json · scripts/optimize.mjs
3-month check:  2026-09-08
12-month verdict: 2027-06-08
Primary metric: Sharpe ratio (H1)
```

Related docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [ASSUMPTIONS.md](ASSUMPTIONS.md) · [CALIBRATION.md](portfolio-app/CALIBRATION.md) · [live-dashboard-portfolio/README.md](live-dashboard-portfolio/README.md)
