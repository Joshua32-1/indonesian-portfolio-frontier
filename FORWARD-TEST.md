# Forward-Test Protocol — IDX Portfolio Tracker

Out-of-sample validation of the `portfolio-app` quant engine using live IDX price data, starting 2026-06-30.

## What is being tested

The forward test is a **methodology matrix**, not a single strategy set. **300 live streams = 10 configs × 6 strategy variants × 5 κ** are tracked against IHSG from a fixed inception date:

- **Variants (6):** Max Sharpe, Min Variance, Tail λ=0.10/0.20/0.35/0.50.
- **Configs (10):** `pert` (legacy Beta-PERT consensus, BL off) **plus** Black-Litterman × prior `{cap, shrunk, equal}` × τ `{0.01, 0.03, 0.10}` (= 9 BL configs).
- **Turnover κ (5):** `{0, 0.1, 0.25, 0.5, 0.75}` — a **post-hoc** turnover penalty applied by blending each stream's κ=0 target toward its own drifted prior weights, mirroring the backtester's `blendTowardDrift`. κ=0 is the full-rebalance target; higher κ trades partway (less churn). This is distinct from the *optimizer's* objective-integrated turnover penalty — see [ASSUMPTIONS.md](ASSUMPTIONS.md).
- **Stream id:** `<base>@<configTag>` for κ=0 (unchanged), `<base>@<configTag>-k<KK>` for κ>0 where `KK = round(κ·100)` — e.g. `tail-20@pert`, `max-sharpe@bl-cap-t03`, `min-var@bl-cap-t03-k25`. The configTag is `pert` or `bl-<prior>-t<NN>` where `NN = round(τ·100)`.

Each stream carries the fields `{ id, base, methodology, prior, tau, kappa, label, rebalances }` in `portfolios.json`. The optimizer is re-run weekly (per config) producing the κ=0 targets; the merge step then κ-expands each into the 5-κ axis and appends a dated rebalance row per stream. The live dashboard (`live-dashboard-portfolio`) tracks realized compounded returns continuously and computes the forward-test metrics described below.

**Frequency (weekly/monthly/quarterly) and gross/net-of-cost are NOT stored** — they are **derived in the dashboard** from the stored daily streams (frequency by sub-sampling the rebalance schedule; net-of-cost via a liquidity-aware trailing-63 ADV model in `live-dashboard-portfolio/src/math/transactionCosts.js`, fed by the snapshot's `dollarVol` field). The dashboard exposes Methodology / Prior / τ / κ / Frequency / Cost selectors to slice the matrix.

This is a genuine **out-of-sample** test — the optimizer was built and calibrated before 2026-06-30, and no in-sample data after that date is used to tune it.

---

## Hypotheses and success criteria

| # | Hypothesis | Success criterion | Verdict date |
|---|-----------|------------------|-------------|
| **H1** | Risk-adjusted outperformance: the optimizer produces at least one stream with higher Sharpe than IHSG | Any stream Sharpe > IHSG Sharpe after 12 months of live data | 2027-06-30 |
| **H2** | Tail protection: higher-λ portfolios show shallower drawdowns during IDX sell-offs | During any IHSG drawdown > 5%, both tail-35 and tail-50 max DD ≤ 70% of IHSG max DD | Rolling — first qualifying event |
| **H3** | Forecast calibration: analyst price targets (consensus-weighted by the max-sharpe portfolio) land within 15% of realized prices | \|realized_price / analyst_target − 1\| < 0.15 for the consensus-weighted basket | 2027-06-30 |
| **H4** | Methodology edge: at least one BL config beats legacy PERT on the same variant | BL `<variant>@bl-…` Sharpe > matching `<variant>@pert` Sharpe after 12 months | 2027-06-30 |

**Primary metric: H1 (Sharpe ratio)**. The dashboard's Sharpe column is the main verdict signal.

---

## Rebalance protocol — automated, every Sunday

Rebalances run **automatically** — no local optimizer run needed.

[`.github/workflows/weekly-rebalance.yml`](.github/workflows/weekly-rebalance.yml)
runs Sundays at 12:00 UTC (19:00 WIB) — the new weights become effective on Monday's
first trading bar — as a **parallel config matrix**:

1. Fetches a fresh optimizer snapshot (Yahoo prices, analyst targets, BI-Rate).
2. Runs [`portfolio-app/scripts/optimize.mjs`](portfolio-app/scripts/optimize.mjs)
   once per **config** — all 10 (`pert` + BL × prior`{cap,shrunk,equal}` × τ`{0.01,0.03,0.10}`) —
   each with `--emit`, writing **only its own 6 κ=0 streams** to a per-config artifact (so
   parallel jobs never clobber the shared file).
3. A **merge** job runs
   [`live-dashboard-portfolio/scripts/merge-rebalances.mjs`](live-dashboard-portfolio/scripts/merge-rebalances.mjs)
   to append every emitted κ=0 stream's dated rebalance row into `portfolios.json`, **and to
   synthesize the κ>0 variant rows** (post-hoc blend toward drift) — 300 streams in one shot.
4. **Commits `portfolios.json` directly to `main`** (no PR). The push auto-redeploys Vercel.

The **full 10-config matrix runs every week** (κ-expanded to 300 streams in the merge step).
For a local recompute, re-seed via [`portfolio-app/scripts/seed-forward-matrix.mjs`](portfolio-app/scripts/seed-forward-matrix.mjs)
(sequential, resumable).

There is **no human review gate** — the push redeploys production automatically. The guardrail
is `merge-rebalances.mjs`, which **fails the job (no push)** if any weight map doesn't sum to
~1 (±0.005), references an unknown stream id, or has a malformed effective date, so malformed
weights never reach production (tickers themselves are *not* validated against the universe). Past
index values never change — only the slope from the new `effective` date forward.

### Reviewing an auto-committed rebalance

Review lands **after the fact** — inspect the auto-commit on `main`:
- Read the weight diff per stream (ids `<base>@<configTag>[-k<KK>]`). Large unexplained
  swings warrant a look at the snapshot (a data glitch or a stale analyst target). To roll
  back, revert the commit (Vercel redeploys the prior weights).
- The merge step enforces each stream's weights sum to ≈1.00 and that its id exists
  in `portfolios.json`, failing the job otherwise — so a green run is already validated.
- To skip a week, revert the auto-commit before market open. History stays append-only
  either way (a skipped week simply carries the prior weights forward).

### Tuning methodology

The config **default** is still legacy PERT — `optimizer-config.json` keeps
`factorConfig.useFactorModel: false`. Per-run methodology is selected by CLI flag, so
the same optimizer produces every config in the matrix. Shared knobs (MC iterations,
correlation window, sector caps, tail penalty) live in
[`portfolio-app/optimizer-config.json`](portfolio-app/optimizer-config.json); editing
them changes **all future** automated runs. Per the guardrails below, changing
methodology mid-test is deliberate: note it in this doc when you do.

### Manual / local run

Trigger from the GitHub Actions UI (*Run workflow* → optional `effective` date), or
locally to preview:

```bash
cd portfolio-app
npm run fetch-snapshot
node scripts/optimize.mjs --dry-run                          # legacy-PERT preview, no write
node scripts/optimize.mjs --methodology bl --prior-mode cap --tau 0.03 --dry-run
node scripts/optimize.mjs --dry-run --iterations 2000 --paths 100   # fast smoke test
```

`optimize.mjs` flags:
- `--methodology pert|bl` — `bl` overrides `useFactorModel → true` (default: config = `pert`).
- `--prior-mode cap|shrunk|equal` — BL equilibrium prior (`bl` only); `cap` is identity
  (byte-identical to no flag), `equal` = 1/n, `shrunk` = 0.5·cap + 0.5·equal.
- `--tau <n>` — overrides `factorConfig.tau` for the BL posterior (`bl` only).
- `--emit <file>` — write this config's streams to an artifact (for the cron's merge
  step) instead of appending `portfolios.json`. Emitted ids are the κ=0 targets tagged
  `<base>@<configTag>`; the merge step derives the κ>0 (`-k<KK>`) variants.
- `--effective YYYY-MM-DD`, `--dry-run`, `--iterations N`, `--paths N` (the last two
  override config for CI tuning / fast tests).

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

Open the live dashboard (deployed on Vercel). Use the **Methodology / Prior / τ / κ / Frequency / Cost** selectors at the top to choose a matrix slice — the **Performance Metrics** table then shows one row per **variant** for the selected config (PERT ignores Prior/τ; BL slices by prior + τ; both slice by κ), at the selected rebalance frequency, gross or net of cost.

| Column | What it measures | How to interpret |
|--------|----------------|-----------------|
| **Total Return** | Cumulative compounded return since 2026-06-30, indexed from 100 | Simple comparison; not risk-adjusted |
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
| **2026-09-30** | 3-month diagnostic | Review the metrics table across a few slices. Check for gross failures: any stream tracking error > 40%, Sharpe below −2, or obvious data gaps. Not a verdict — just an early warning check. |
| **2027-06-30** | 12-month verdict | Evaluate H1–H4 against the success criteria above. Document findings in CALIBRATION.md. |

---

## Guardrails

These rules protect the integrity of the out-of-sample test:

- **Never backfill** — do not add `rebalances[]` entries with past `effective` dates after the fact.
- **Never edit past rebalances** — the `rebalances[]` array is append-only. The dashboard's stitched index depends on this invariant.
- **Don't change the inception date** — `portfolios.json → inception: 2026-06-30` is fixed for the life of this test.
- **Don't change the matrix axes mid-test** — the 6 variants (max-sharpe, min-var, tail-10/20/35/50), the 10 configs (pert + BL × prior{cap,shrunk,equal} × τ{0.01,0.03,0.10}), and the 5 κ values ({0,0.1,0.25,0.5,0.75}) must remain fixed so the comparison is clean. (Re-init the skeleton only via `init-portfolios-matrix.mjs` before any weights are seeded; add κ streams to an already-seeded file only via `add-kappa-streams.mjs` + `backseed-kappa.mjs`, run once before those streams go live.)
- **Don't retrain the model on post-inception data** — calibration (CALIBRATION.md) is frozen at inception. Shared-knob changes go through `optimizer-config.json` and must be recorded here.

---

## Quick reference

```
Inception:      2026-06-30
Matrix:         300 streams = 10 configs × 6 variants × 5 κ  (id = <base>@<configTag>[-k<KK>])
Variants:       max-sharpe, min-var, tail-10, tail-20, tail-35, tail-50
Configs:        pert + BL × prior{cap,shrunk,equal} × τ{0.01,0.03,0.10}
Kappa:          {0, 0.1, 0.25, 0.5, 0.75} — post-hoc turnover blend (κ=0 = full rebalance)
Derived:        frequency {weekly,monthly,quarterly} + gross/net — computed in dashboard
BI-Rate (rf):   5.75% (portfolios.json → riskFreeRate: 0.0575)
Rebalance:      Automated weekly auto-commit to main, Sundays 12:00 UTC — parallel config
                matrix (optimize.mjs --emit per config → merge-rebalances.mjs → push to main)
CI snapshot:    Weekdays 11:00 UTC (18:00 WIB) via .github/workflows/refresh-dashboard.yml
Skeleton:       live-dashboard-portfolio/scripts/init-portfolios-matrix.mjs
Full re-seed:   portfolio-app/scripts/seed-forward-matrix.mjs (sequential, resumable)
Optimizer cfg:  portfolio-app/optimizer-config.json · scripts/optimize.mjs
3-month check:  2026-09-30
12-month verdict: 2027-06-30
Primary metric: Sharpe ratio (H1)
```

Related docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [ASSUMPTIONS.md](ASSUMPTIONS.md) · [CALIBRATION.md](portfolio-app/CALIBRATION.md) · [live-dashboard-portfolio/README.md](live-dashboard-portfolio/README.md)
