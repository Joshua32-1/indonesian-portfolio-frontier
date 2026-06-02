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

**Update prices for dashboard:** `cd portfolio-app && npm run fetch-snapshot`, then `cd ../live-dashboard-portfolio && npm run sync-snapshot`.

See [`live-dashboard-portfolio/README.md`](live-dashboard-portfolio/README.md) for Vercel deploy and rebalance workflow.
