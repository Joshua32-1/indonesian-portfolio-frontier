# CLAUDE.md

Orientation for Claude (and other AI agents) working in this repository. Read this first, then the topic docs linked below.

## What this repo is

A **monorepo** for an Indonesia Stock Exchange (IDX) quantitative portfolio workflow. Three apps, one direction of data flow:

| App | Role | Runs where |
|-----|------|------------|
| [`portfolio-app/`](portfolio-app/) | **Optimizer** — Monte Carlo + Black-Litterman + tail-aware robust optimization. Research/construction tool. Produces candidate portfolio weights. | Local only |
| [`backtest-portfolio/`](backtest-portfolio/) | **Backtester** — look-ahead-free, cost-aware walk-forward evaluation of the machinery (tail-aware Max-Sharpe + tail-λ variants vs min-variance / equal-weight / IHSG), **net of IDX transaction costs** (gross alongside), across weekly/monthly/quarterly with a turnover-penalty (κ) sweep. | Local only |
| [`live-dashboard-portfolio/`](live-dashboard-portfolio/) | **Tracker** — indexed performance of chosen portfolios vs. IHSG. Consumes weights appended either by hand or by the automated weekly rebalance. | Vercel (production) |

The apps **share data contracts but no code**. The optimizer is the source of weights; the dashboard tracks them. Weights reach the dashboard either manually (analyst copies from the Analytics tab) or via the automated weekly rebalance ([`portfolio-app/scripts/optimize.mjs`](portfolio-app/scripts/optimize.mjs) + `.github/workflows/weekly-rebalance.yml`). See [ARCHITECTURE.md](ARCHITECTURE.md).

## Commands

**`portfolio-app/`** (`package.json` scripts):
```bash
npm run dev              # predev auto-runs fetch-snapshot, then Vite dev server (port 5173)
npm run build            # fetch-snapshot && vite build
npm run fetch-snapshot   # node data/fetch-snapshot.js — rebuild ~1MB snapshot from Yahoo + BI-Rate
npm run refresh-sectors  # node data/refresh-sectors.js — update sector labels only (fast, no price refetch)
node scripts/validate-factors.mjs   # math regression suite — RUN AFTER ANY src/math/ CHANGE
```

**`backtest-portfolio/`**:
```bash
npm run fetch            # node scripts/fetch-backtest-history.mjs — full daily+weekly history + liquidity + shares-out
npm run backtest         # node scripts/run-strategy-backtest.mjs — precompute tail-aware variants × frequency × κ-sweep → public/backtest-results.json
npm run dev              # Vite dev server (port 5174) — live explorer + precomputed strategy panel
```

**`live-dashboard-portfolio/`**:
```bash
npm run dev              # Vite dev server
npm run build            # vite build → dist/
npm run fetch-snapshot   # node scripts/fetch-daily-snapshot.mjs — lean daily snapshot (incl. dollarVol; CI runs this)
node scripts/init-portfolios-matrix.mjs   # (re)init the EMPTY 300-stream matrix skeleton (refuses if seeded)
node scripts/add-kappa-streams.mjs        # additively add the κ>0 skeletons to a seeded portfolios.json
node scripts/backseed-kappa.mjs           # one-shot: seed κ>0 history for existing effective dates
node scripts/merge-rebalances.mjs <emit…> # assemble per-config emits → portfolios.json + κ-expand (cron merge step)
```

**Forward-test matrix (optimizer side):** `portfolio-app/scripts/optimize.mjs` is BL-capable per run via flags — `--methodology pert|bl`, `--prior-mode cap|shrunk|equal`, `--tau <n>`, `--emit <file>` — and tags emitted (κ=0) stream ids `<base>@<configTag>`. The config **default is still legacy PERT** (`optimizer-config.json → factorConfig.useFactorModel:false`). Seed the full 10-config matrix locally with `portfolio-app/scripts/seed-forward-matrix.mjs` (sequential, resumable). The **κ axis** {0,0.1,0.25,0.5,0.75} is NOT an optimize.mjs flag — κ>0 streams (`-k<KK>`) are derived downstream by `merge-rebalances.mjs` as a post-hoc blend toward drift (mirrors the backtester's `blendTowardDrift`). See [FORWARD-TEST.md](FORWARD-TEST.md).

**Automated (root `.github/workflows/`):** `refresh-dashboard.yml` (daily lean snapshot), `refresh-views.yml` (weekly analyst-view capture), `weekly-rebalance.yml` (weekly rebalance as a **parallel config matrix** over all 10 configs — `optimize.mjs --emit` per config → `merge-rebalances.mjs` appends κ=0 rows and κ-expands to 300 streams → **auto-commits to `main`**, no PR), `refresh-backtest.yml` (weekly full backtest sweep — `npm run fetch && npm run backtest` → commits `backtest-results.json`).

**Ticker universe:** the investable list lives once in [`portfolio-app/data/universe.js`](portfolio-app/data/universe.js) (`UNIVERSE_JK`, `.JK` suffix) and is imported by all three fetch scripts. The dashboard fetch unions in any ticker still held in `portfolios.json` so removed names stay tracked; the optimizer/backtest use the canonical list. See the [`add-ticker`](.claude/skills/add-ticker/SKILL.md) skill.

## Golden rules

1. **Pure JavaScript, no TypeScript.** Files are `.js` / `.jsx` / `.mjs`. Don't introduce `.ts`.
2. **`src/math/` modules must stay pure** — no React, no I/O, no DOM. They take data, return data. This is what makes them testable by `validate-factors.mjs` and reusable across the apps (the backtester imports them directly from `portfolio-app/src/math/`).
3. **Run the validation suite after editing any `src/math/` file:** `cd portfolio-app && node scripts/validate-factors.mjs`. It exercises legacy vs. tail-aware modes, the factor model, shrinkage, and stress outputs.
4. **Never hand-edit `live-market-snapshot.json`** in either app — it is generated by a fetch script. To change it, change the fetch script or the ticker list and re-run.
5. **`portfolios.json` is the one manually-maintained data file.** It is append-only: add new dated `rebalances[]` entries, never overwrite history. Weights are fractions that must sum to ~1.00. See [API.md](API.md#portfoliosjson).
6. **Don't trust a number without reading [ASSUMPTIONS.md](ASSUMPTIONS.md).** The model bakes in IDX-specific calibration (analyst optimism, BI-Rate, annualization conventions).

## Conventions

- **Annualization:** daily σ × √252, weekly σ × √52, 252 trading days/year (`SQRT_252` in `matrixEngine.js`).
- **Risk-free rate:** Bank Indonesia BI-Rate, live-fetched at snapshot time, fallback **5.75%** (`BI_RATE_FALLBACK` in `fetch-snapshot.js`). Used as `r_f` everywhere.
- **Tickers:** Yahoo is *queried* with the `.JK` suffix (`BBCA.JK`); both snapshots, `portfolios.json`, and the dashboard store the bare symbol (`BBCA`) — the fetch scripts strip the suffix.
- **Currency:** all monetary values are IDR.
- **Benchmark:** IHSG = Jakarta Composite Index, Yahoo ticker `^JKSE`.

## Where things live

| Topic | Doc |
|-------|-----|
| Data + module contracts (snapshot schema, `portfolios.json`, math API) | [API.md](API.md) |
| Modeling assumptions & limitations | [ASSUMPTIONS.md](ASSUMPTIONS.md) |
| Monorepo structure, data flow, deployment, CI | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Quant + IDX terminology | [GLOSSARY.md](GLOSSARY.md) |
| Forward-test protocol (methodology matrix, rebalance cron) | [FORWARD-TEST.md](FORWARD-TEST.md) |
| Dev setup & contribution rules | [CONTRIBUTING.md](CONTRIBUTING.md) |
| **Deep math walkthrough (authoritative)** | [portfolio-app/README.md](portfolio-app/README.md) |
| **Prescriptive tuning (what values to set)** | [portfolio-app/CALIBRATION.md](portfolio-app/CALIBRATION.md) |
| Dashboard deploy & rebalance workflow | [live-dashboard-portfolio/README.md](live-dashboard-portfolio/README.md) |

## Agents & skills

This repo ships subagents and skills under [`.claude/`](.claude/). Reach for them at the matching point in a task rather than working from scratch.

**Agents** (`.claude/agents/`) — delegate a review to one of these:

| Agent | Use when |
|-------|----------|
| [`quant-math-reviewer`](.claude/agents/quant-math-reviewer.md) | You changed anything under `portfolio-app/src/math/`. It runs `validate-factors.mjs` and checks the math against [ASSUMPTIONS.md](ASSUMPTIONS.md). **Prefer this over `code-reviewer` for math.** |
| [`code-reviewer`](.claude/agents/code-reviewer.md) | You changed non-math app code (components, scripts, config) and want a correctness/idiom pass. |
| [`data-pipeline-checker`](.claude/agents/data-pipeline-checker.md) | You touched a fetch script, the snapshot shape, or `portfolios.json` — validates schema + the cross-app data contract. |
| [`docs-maintainer`](.claude/agents/docs-maintainer.md) | You changed a formula, a config default, a signature, or a script name — sweeps the root docs back into sync. |

**Skills** (`.claude/skills/`) — invoke for these recurring tasks:

| Skill | Use when |
|-------|----------|
| [`validate-quant-math`](.claude/skills/validate-quant-math/SKILL.md) | After editing `src/math/`: run and interpret the regression suite. |
| [`refresh-snapshot`](.claude/skills/refresh-snapshot/SKILL.md) | Prices/targets are stale, or you changed the ticker list — rebuild + validate the right snapshot. |
| [`rebalance-portfolio`](.claude/skills/rebalance-portfolio/SKILL.md) | Moving chosen weights from the optimizer into `portfolios.json` (the optimizer→dashboard handoff). |
| [`add-ticker`](.claude/skills/add-ticker/SKILL.md) | Adding/removing an IDX ticker across the fetch list, snapshot, and downstream caps. |
