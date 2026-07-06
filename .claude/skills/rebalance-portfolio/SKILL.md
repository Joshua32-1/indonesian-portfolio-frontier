---
name: rebalance-portfolio
description: Append a new dated rebalance entry to live-dashboard-portfolio/data/portfolios.json — the optimizer→dashboard handoff. Use after a REGENERATE run when moving chosen weights into the live tracker. Enforces the append-only, weights-sum-to-1, bare-ticker contract.
---

# Rebalance portfolio

Moves chosen weights from the optimizer into the dashboard's tracked history. The dashboard stitches a continuous index, so **history is append-only** — never overwrite past entries.

> **κ streams are derived, not hand-authored.** Manual appends target the **κ=0** streams (`<base>@<configTag>`). The κ>0 variants (`<base>@<configTag>-k<KK>`) are synthesized automatically by `merge-rebalances.mjs` (a post-hoc blend of the κ=0 target toward the drifted prior, mirroring the backtester's `blendTowardDrift`) — do not hand-edit them. If you append a κ=0 row by hand outside the merge step, run `node scripts/backseed-kappa.mjs` afterward to keep the κ>0 siblings in sync.

## Inputs you need

- The strategy `id` (one of: `max-sharpe`, `min-var`, `tail-10`, `tail-20`, `tail-35`, `tail-50`, or a new one) — the **κ=0** stream.
- The effective date (`YYYY-MM-DD`) the weights take effect.
- The weight map, read from the optimizer's **Analytics** tab.

## Procedure

1. Open `live-dashboard-portfolio/data/portfolios.json`.
2. Find the portfolio object with the matching `id`. **Append** to its `rebalances[]`:
   ```json
   { "effective": "2026-06-22", "weights": { "BBCA": 0.09, "BBRI": 0.06, "...": 0.0 } }
   ```
   Do **not** edit or remove existing rebalance rows.
3. Bump the top-level `"updated"` to today.

## Validate before saving (hard requirements — see API.md)

- **Weights sum to ≈ 1.00** (within ~0.005). Quick check:
  ```bash
  node -e "const p=require('./live-dashboard-portfolio/data/portfolios.json'); for(const x of p.portfolios){const r=x.rebalances.at(-1); const s=Object.values(r.weights).reduce((a,b)=>a+b,0); console.log(x.id, r.effective, s.toFixed(4))}"
  ```
- **Tickers are bare symbols** (`BBCA`, not `BBCA.JK`) and **every ticker exists** in `live-dashboard-portfolio/data/live-market-snapshot.json` assets.
- `rebalances[]` stays sorted ascending by `effective`.
- New strategy? Also add a colour entry in `live-dashboard-portfolio/src/App.jsx` `COLORS`.

## Point-in-time inputs (for future κ-replay)

This is **separate** from the live κ-sweep above. The live κ streams are a cheap **post-hoc blend** of the stored κ=0 weights (done in `merge-rebalances.mjs`). The **κ-replay** below is a higher-fidelity alternative — re-optimize from archived inputs at any κ — kept available but not run weekly. The two don't conflict.

Analyst views are captured **automatically every week** by the `Capture Analyst Views` GitHub Action (and on any local `npm run fetch-snapshot`) into `portfolio-app/data/view-history/views-YYYY-MM-DD.json` — a trimmed file holding `forwardEstimates` + caps + dividend yield + `riskFreeRate`. Together with prices reconstructible from `backtest-portfolio/public/backtest-history.json`, this is everything a future replay needs to recompute the optimizer's weights at any turnover-penalty κ (or λ). **No manual snapshot copy is needed.**

Optional but recommended at each rebalance: add a `views` reference to the new rows so the link is explicit:
```json
{ "effective": "2026-07-15", "weights": { "BBCA": 0.09, "...": 0.0 }, "views": "view-history/views-2026-07-10.json" }
```
Use the latest `view-history` file with `asOf` ≤ `effective`. (Inception rows predate capture and have no `views` link.)

## Finish

Commit and push (only when the user asks) → Vercel auto-redeploys. The chart's past values won't change; only the future slope from `effective` onward.
