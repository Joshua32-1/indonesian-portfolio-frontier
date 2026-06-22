# Indonesian Portfolio Monorepo

| Directory | Purpose |
|-----------|---------|
| [`portfolio-app/`](portfolio-app/) | IDX portfolio optimizer (Monte Carlo, efficient frontier). Run locally. |
| [`live-dashboard-portfolio/`](live-dashboard-portfolio/) | Minimal live tracker (IHSG vs model portfolios). Deploy to **Vercel** with Root Directory = `live-dashboard-portfolio`. |

## Quick start

**Optimizer (local):**
```bash
cd portfolio-app && npm install && npm run dev
```

**Live dashboard (local):**
```bash
cd live-dashboard-portfolio && npm install && npm run dev
```

**Refresh optimizer data:** `cd portfolio-app && npm run fetch-snapshot` (rebuilds the rich snapshot from Yahoo Finance + BI-Rate).

**Refresh dashboard data:** the dashboard maintains its own lean daily snapshot via `cd live-dashboard-portfolio && npm run fetch-snapshot`. This runs automatically on weekdays via CI ([`.github/workflows/refresh-dashboard.yml`](.github/workflows/refresh-dashboard.yml)) — you rarely need to run it by hand.

See [`live-dashboard-portfolio/README.md`](live-dashboard-portfolio/README.md) for Vercel deploy and rebalance workflow.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [CLAUDE.md](CLAUDE.md) | Start here — repo map, commands, golden rules (for humans and AI agents). |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Monorepo structure, data flow between the two apps, deployment & CI. |
| [API.md](API.md) | Data contracts (snapshot schema, `portfolios.json`) and the `src/math/` public API. |
| [ASSUMPTIONS.md](ASSUMPTIONS.md) | Modeling assumptions and limitations baked into every result. |
| [GLOSSARY.md](GLOSSARY.md) | Quant + IDX terminology. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, math-purity rules, validation, rebalance procedure. |
| [portfolio-app/README.md](portfolio-app/README.md) | Deep math walkthrough (authoritative). |
| [portfolio-app/CALIBRATION.md](portfolio-app/CALIBRATION.md) | Prescriptive tuning — what values to set for a given universe. |

This repo also ships Claude Code agents and skills under [`.claude/`](.claude/) (e.g. a `quant-math-reviewer` agent and a `rebalance-portfolio` skill) — see [CLAUDE.md](CLAUDE.md#agents--skills).
