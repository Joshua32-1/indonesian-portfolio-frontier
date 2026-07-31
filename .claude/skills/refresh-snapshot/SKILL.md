---
name: refresh-snapshot
description: Rebuild a market-data snapshot for one of the two apps from Yahoo Finance (+ BI-Rate for the optimizer), then validate the output. Use when prices/targets are stale or after changing the ticker list. Picks the right script per target app.
---

# Refresh snapshot

Two snapshots exist; pick the target deliberately — they use different scripts and shapes (see `API.md`).

## Optimizer (rich snapshot, ~1 MB, weekly history + daily vol + analyst targets + BI-Rate)

```bash
cd portfolio-app
npm run fetch-snapshot          # node data/fetch-snapshot.js
# fast path (sector labels only, no price refetch):
# npm run refresh-sectors
```

Writes `portfolio-app/data/live-market-snapshot.json`.

## Dashboard (lean snapshot, ~14 KB, daily adjusted closes only — normally CI does this)

```bash
cd live-dashboard-portfolio
npm run fetch-snapshot          # node scripts/fetch-daily-snapshot.mjs
```

Writes `live-dashboard-portfolio/data/live-market-snapshot.json`. CI already runs this on weekdays (`refresh-dashboard.yml`) — only run by hand if you need an off-cycle refresh.

## After fetching — validate

1. **It's valid JSON and non-trivial:** `node -e "const s=require('./data/live-market-snapshot.json'); console.log(s.assets.length, 'assets', s.generated)"` (adjust path).
2. **Optimizer extras:** `riskFreeRate` is a sane decimal (≈0.0575 unless BI changed) and `riskFreeRateEffective` names the BI decision date. The rate is read from the `bi-rate.json` archive (refreshed by `predev`), not scraped here — only `↓ using fallback` means the archive was unreadable. Every asset has `meta` + `forwardEstimates`, `low ≤ mean ≤ high`.
3. **Smoke-test the math** (optimizer only): `node scripts/validate-factors.mjs` should run clean against the new snapshot.
4. **Report the diff**, not just success: which fields/prices moved, how many assets, the `generated` timestamp, and any tickers Yahoo failed to return.

## Notes

- Never hand-edit the snapshot — re-run the script instead.
- The fetch hits Yahoo for prices; r_f comes from the committed `bi-rate.json` archive (or 5.75% if unreadable). Offline you keep a correct r_f but cannot get prices.
