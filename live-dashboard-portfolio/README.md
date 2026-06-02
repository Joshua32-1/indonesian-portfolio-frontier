# IDX Portfolio Tracker — Live Dashboard

Minimal Vercel-hosted dashboard showing **indexed performance** (IHSG vs Max Sharpe, Min Variance, Tail λ=0.10/0.20/0.35/0.50) and latest portfolio weights.

## Stack

- Vite + React (static SPA — no backend)
- Recharts for charting
- Data: `data/live-market-snapshot.json` (auto-refreshed by CI) + `data/portfolios.json` (you maintain)

---

## Vercel deploy

1. Push this repo to GitHub.
2. Create a new Vercel project → **Import** → select this repo.
3. Set **Root Directory** to `live-dashboard-portfolio`.
4. **Build command:** `npm run build`  **Output directory:** `dist`  **Install:** `npm ci`
5. Deploy — done. No environment variables needed.

---

## Weekly workflow

### After each rebalance / REGENERATE run

1. Open `portfolio-app` locally and click **REGENERATE**.
2. In **Analytics**, note the weights for each strategy (Consensus, Min Var, Frontier λ rows).
3. Open `live-dashboard-portfolio/data/portfolios.json`.
4. For each changed strategy, **append** a new rebalance entry (do NOT overwrite old rows):

```json
{
  "effective": "2026-06-09",
  "weights": {
    "BBCA": 0.15,
    "BBRI": 0.12,
    ...
  }
}
```

5. Update `"updated"` at the top of `portfolios.json` to today's date.
6. Commit and push → Vercel auto-redeploys.

> Weights are **fractions** (0.15 = 15%). All weights in a rebalance entry must sum to approximately 1.00. The TOTAL row in the dashboard turns red if the sum is off.

---

## Price refresh (automatic)

A GitHub Action (`.github/workflows/refresh-dashboard.yml`) runs on weekdays at 11:00 UTC (18:00 WIB — after IDX close) to:

1. Run `npm run fetch-snapshot` inside `live-dashboard-portfolio`.
2. Commit and push the updated snapshot if changed → Vercel redeploys.

The fetch script is self-contained in this folder. It uses `yahoo-finance2` `chart()` (not `historical()`) to avoid errors on unsettled recent bars, and drops any bar where `adjclose` is null. Yahoo typically lags 1–2 trading sessions before finalized adj closes are available.

To run locally:

```bash
cd live-dashboard-portfolio
npm run fetch-snapshot
npm run dev
```

---

## Stitched history

The chart **never resets** when you add a new rebalance. The index compounds continuously from `inception`:

- Each daily bar: `index_t = index_{t-1} × exp(Σ w_i(t) · r_i,t)`
- `w_i(t)` = the weight active on or before that bar's date
- Weekends and IDX holidays have no bar — the next trading day's return spans the full gap
- Adding a new `effective` row only changes the **future slope** of the line; past values are identical

---

## Adding/removing strategies

- **Add**: append a new object to `portfolios[]` with a unique `id`, `label`, and `rebalances[{ effective, weights }]`.
- **Remove**: delete the object from `portfolios[]`.
- **Colour**: assign a colour in `src/App.jsx` `COLORS` map.

---

## `portfolios.json` format

```json
{
  "inception": "YYYY-MM-DD",
  "updated": "YYYY-MM-DD",
  "portfolios": [
    {
      "id": "max-sharpe",
      "label": "Max Sharpe (Consensus)",
      "rebalances": [
        { "effective": "2026-06-02", "weights": { "BBCA": 0.14, ... } },
        { "effective": "2026-07-01", "weights": { "BBCA": 0.12, ... } }
      ]
    }
  ]
}
```

Tickers must match exactly those in `live-market-snapshot.json` assets (e.g. `BBCA`, not `BBCA.JK`).
