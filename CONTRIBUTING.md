# CONTRIBUTING.md

## Prerequisites

- **Node 20** (matches CI). No global tooling beyond npm.
- Each app has its own `package.json` — install per app.

## Setup

```bash
# Optimizer
cd portfolio-app && npm install && npm run dev      # predev fetches a fresh snapshot, then serves on :5173

# Backtester (local, cost-aware walk-forward)
cd backtest-portfolio && npm install && npm run fetch && npm run backtest && npm run dev   # serves on :5174

# Dashboard
cd live-dashboard-portfolio && npm install && npm run dev
```

## Project conventions

- **Pure JavaScript, ESM, no TypeScript.** `.js` / `.jsx` / `.mjs` only.
- **`src/math/` modules are pure** — no React, no I/O, no DOM. Inputs and outputs are plain data. This is what lets `validate-factors.mjs` test them and lets shared helpers run across the apps (the backtester imports them directly from `portfolio-app/src/math/`).
- Match the surrounding style: JSDoc-style block comments on exported functions, descriptive names, fractions for weights/rates.

## Editing the quant engine (`portfolio-app/src/math/`)

This is the highest-risk area. After **any** change:

```bash
cd portfolio-app
node scripts/validate-factors.mjs      # must run clean
```

The suite exercises legacy (`avgMuSharpe`) vs. tail-aware modes, the factor model on/off, Ledoit-Wolf shrinkage, and consensus/stress outputs. If you add a new behavior, extend the suite to cover it. The [`validate-quant-math`](.claude/skills/validate-quant-math/SKILL.md) skill runs and interprets this output for you.

When changing a formula, constant, or default, also:
- Update [API.md](API.md) (if a signature/constant changed) and [ASSUMPTIONS.md](ASSUMPTIONS.md) (if model behavior changed). The [`docs-maintainer`](.claude/agents/docs-maintainer.md) agent can do this sweep.
- Consider running the [`quant-math-reviewer`](.claude/agents/quant-math-reviewer.md) agent before committing.

## Data files

- **Never hand-edit `live-market-snapshot.json`** in either app — it is generated. To change its contents, change the fetch script (or the `TICKERS` list) and re-run `npm run fetch-snapshot`. See the [`refresh-snapshot`](.claude/skills/refresh-snapshot/SKILL.md) and [`add-ticker`](.claude/skills/add-ticker/SKILL.md) skills.
- **`portfolios.json`** (dashboard) is the only data file you may edit by hand (it is also appended to automatically by the weekly-rebalance Action via `optimize.mjs`). It is **append-only**: add new dated `rebalances[]` entries, never overwrite old ones; weights are fractions summing to ≈ 1.00; tickers are bare symbols (`BBCA`, not `BBCA.JK`); bump `"updated"`. See the [`rebalance-portfolio`](.claude/skills/rebalance-portfolio/SKILL.md) skill.
- After changing any fetch script, snapshot shape, or `portfolios.json`, run the [`data-pipeline-checker`](.claude/agents/data-pipeline-checker.md) agent to validate the schema and the cross-app contract.

## Rebalance procedure (optimizer → dashboard)

Weights reach `portfolios.json` one of two ways:

`portfolios.json` is a **methodology matrix** of 60 streams (`<base>@<configTag>`); weights reach it one of two ways:

**Manual:**
1. In `portfolio-app`, click **REGENERATE** and read the chosen weights off the **Analytics** tab.
2. In `live-dashboard-portfolio/data/portfolios.json`, append a `{ "effective": "<date>", "weights": { ... } }` entry to the relevant **stream** (matching its methodology/prior/τ).
3. Verify the weights sum to ≈ 1.00 and every ticker exists in the snapshot.
4. Bump `"updated"`, commit, and push → Vercel auto-redeploys.

**Automated:** the `weekly-rebalance.yml` Action runs a **parallel config matrix** — each `portfolio-app/scripts/optimize.mjs --emit` job (same `src/math/` engine, no UI) writes only its config's streams to an artifact, then a merge job runs `live-dashboard-portfolio/scripts/merge-rebalances.mjs` to append every stream's dated row into `portfolios.json` and opens one PR. Separately, `refresh-views.yml` archives point-in-time analyst views weekly into `portfolio-app/data/view-history/` for later κ-replay.

## Commits

- Keep commits focused. The repo's automated snapshot commits use the `chore: refresh IDX daily snapshot <date>` convention; human commits are short imperative summaries.
- Only commit or push when explicitly asked. The dashboard snapshot is refreshed by CI — don't commit a manual snapshot refresh unless intentional.

## Verification checklist before a PR

- [ ] Reviewed the diff — `code-reviewer` agent for app code, [`quant-math-reviewer`](.claude/agents/quant-math-reviewer.md) for `src/math/`.
- [ ] `node portfolio-app/scripts/validate-factors.mjs` runs clean (if you touched `src/math/`).
- [ ] The affected app(s) build (`npm run build`) if you touched their source.
- [ ] Docs updated for any formula/constant/contract change.
- [ ] No hand-edits to generated `live-market-snapshot.json`.
- [ ] `portfolios.json` weights sum to ≈ 1.00 and tickers resolve.
