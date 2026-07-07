---
name: add-ticker
description: Add or remove an IDX ticker consistently across the shared UNIVERSE_JK list (portfolio-app/data/universe.js), the regenerated snapshot, and downstream sector/position-cap defaults. Use when changing the investable universe. Keeps the optimizer and dashboard ticker namespaces consistent.
---

# Add / remove a ticker

The investable universe is defined in one place but ripples through snapshots, sectors, and (for the dashboard) `portfolios.json`. Do all steps or the apps drift.

## 1. Edit the source list

`portfolio-app/data/universe.js` → the `UNIVERSE_JK` array. Use the Yahoo `.JK` suffix, e.g. `'GOTO.JK'`. (Currently 25 tickers, `BBCA.JK … ISAT.JK`.)

This is the **single source of truth**: all three fetch scripts (`portfolio-app/data/fetch-snapshot.js`, `backtest-portfolio/scripts/fetch-backtest-history.mjs`, `live-dashboard-portfolio/scripts/fetch-daily-snapshot.mjs`) import it, so one edit propagates everywhere. Note the dashboard fetch additionally **unions in** any ticker still referenced in `portfolios.json`, so a name you *remove* from `UNIVERSE_JK` keeps getting priced (and tracked) on the dashboard as long as past rebalances hold it.

## 2. Regenerate the optimizer snapshot

```bash
cd portfolio-app && npm run fetch-snapshot
```

Confirm the new ticker came back with `meta` + `forwardEstimates` (some thin names lack analyst targets — Yahoo may omit `forwardEstimates`; the engine tolerates this but the name will have weak views). Check its `sector` label is sensible; run `npm run refresh-sectors` if it landed as `Other`.

## 3. Sanity-check downstream

- **Sector caps:** a new sector auto-initializes to `DEFAULT_SECTOR_CAP` (0.80). If the addition concentrates a sector, reconsider caps (see `CALIBRATION.md`).
- **Validation:** `node scripts/validate-factors.mjs` runs clean with the new universe.

## 4. Dashboard side (only if the ticker enters a tracked portfolio)

- The dashboard's lean snapshot picks the ticker up automatically — `fetch-daily-snapshot.mjs` imports the same `UNIVERSE_JK` — but only on its next run (weekday CI, or run it by hand). Confirm the new bare symbol (`GOTO`) is present there before tracking it.
- When you add the ticker to a strategy's weights in `portfolios.json`, use the **bare** symbol and re-validate sums (see the `rebalance-portfolio` skill).

## Removing a ticker

Delete it from `UNIVERSE_JK`, regenerate, and **remove it from any `portfolios.json` weights** (re-normalize the remaining weights to sum to 1). Past rebalance rows that reference a now-missing ticker will simply contribute 0 if the asset is absent from the snapshot, but it's cleaner to fix forward-looking entries.

## Validate

After any change: snapshot regenerated, `validate-factors.mjs` clean, `portfolios.json` weights still sum to ≈ 1.00, no `.JK` suffixes leaked into `portfolios.json`.
