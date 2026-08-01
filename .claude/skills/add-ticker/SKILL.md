---
name: add-ticker
description: Add or remove an IDX ticker in portfolio-app/data/universe.js — either the research list UNIVERSE_JK (optimizer + backtester) or the pinned FORWARD_TEST_UNIVERSE_JK the live forward test runs on. Use when changing the investable universe. Keeps snapshots, sector caps, and the optimizer↔dashboard ticker namespaces consistent.
---

# Add / remove a ticker

`portfolio-app/data/universe.js` exports **two lists**. Decide which one you are changing before touching anything — they have very different blast radius.

| List | Drives | Cost of changing |
|------|--------|------------------|
| `UNIVERSE_JK` | Optimizer app (`portfolio-app`), backtester (`backtest-portfolio`) | Cheap. Research only. **Cannot** affect the live forward test. |
| `FORWARD_TEST_UNIVERSE_JK` | The 300 live forward-test streams (`optimize.mjs` + the dashboard's lean snapshot) | **Starts a new experiment.** Read part B first. |

Both use the Yahoo `.JK` suffix, e.g. `'GOTO.JK'`. Currently 25 tickers each, `BBCA.JK … ISAT.JK`.

---

## A. Changing the research universe (`UNIVERSE_JK`) — the usual case

### 1. Edit the list

`portfolio-app/data/universe.js` → the `UNIVERSE_JK` array.

### 2. Regenerate what consumes it

Both apps pick the edit up on their next `npm run dev` — `portfolio-app`'s `predev` always refetches, and `backtest-portfolio`'s `fetch-if-stale` diffs the stored ticker set against `UNIVERSE_JK` and refetches on any add or remove (not just when prices age). To force it without starting a dev server:

```bash
cd portfolio-app         && npm run fetch-snapshot   # optimizer snapshot
cd ../backtest-portfolio && npm run fetch            # walk-forward history (unconditional)
```

Confirm the new ticker came back with `meta` + `forwardEstimates` (thin names may lack analyst targets — Yahoo omits `forwardEstimates`; the engine tolerates this but the name will have weak views). Check its `sector` label is sensible; run `npm run refresh-sectors` if it landed as `Other`.

### 3. Sanity-check downstream

- **Sector caps:** a new sector auto-initializes to `DEFAULT_SECTOR_CAP` (0.80). If the addition concentrates a sector, reconsider caps (see `CALIBRATION.md`).
- **Validation:** `node scripts/validate-factors.mjs` runs clean. Its BL checks reference BIRD/BBCA behind an `if` guard, so removing either silently *skips* two assertions rather than failing.
- **Backtest window:** `run-strategy-backtest.mjs` keeps only names listed on/before `LISTING_CUTOFF` (2012-01-01), so a recently-listed addition is fetched and then **excluded** — `backtest-results.json` won't change. A *pre*-2012 addition does enter, and if it listed later than the current `newestListing` it **shortens the whole backtest window** (start = newest listing + 1yr).
- **Forward test:** unaffected, by design. `optimize.mjs` filters the rich snapshot to the pinned list and logs anything it dropped.

---

## B. Changing the pinned forward-test universe (`FORWARD_TEST_UNIVERSE_JK`)

This moves the opportunity set for all 300 live streams at once, so pre- and post-change performance are not one clean experiment. Do it deliberately and record it in `FORWARD-TEST.md`.

### 1. Check price history before adding

Every pinned name needs bars back to `portfolios.json → inception`. The dashboard aligns prices by **date intersection** (`priceAlign.js`) and `optimize.mjs` emits every pinned ticker **including zero weights** — so a name whose history starts late silently truncates and **rebases every stream's index to 100** at its first bar. A name with full history is a no-op.

### 2. Refresh the lean snapshot before the next Sunday

`optimize.mjs` validates weight-map keys against the *committed* `live-dashboard-portfolio/data/live-market-snapshot.json`, and the rebalance workflow does not rebuild it. If a pinned name is missing there, all 10 matrix jobs fail and the merge job is skipped — **no rebalance that week, no visible error**.

```bash
cd live-dashboard-portfolio && npm run fetch-snapshot   # then commit
```

Or dispatch `refresh-dashboard.yml`. Confirm the new bare symbol (`GOTO`) is in the committed file before Sunday 12:00 UTC.

### 3. Rebuild the optimizer snapshot with the pinned list

```bash
cd portfolio-app && npm run fetch-snapshot:forward
```

`optimize.mjs` **aborts** if a pinned name is missing from the rich snapshot, so this is required before any local `optimize.mjs` or `seed-forward-matrix.mjs` run.

### Removing a pinned ticker

Delete it from `FORWARD_TEST_UNIVERSE_JK`. Past `portfolios.json` rows keep it (append-only) and the dashboard fetch keeps pricing it via the held-ticker union, so history still renders. κ=0 streams drop it at the next rebalance; κ>0 streams decay it at (1−κ)/week via the blend.

Two later hazards:

- If the name is **delisted or suspended**, its date gaps truncate *every stream that ever held it* (intersection alignment).
- If it disappears from the snapshot entirely, its weight silently contributes **zero return at a <100% invested base** — no warning.

When you add a ticker to a strategy's weights in `portfolios.json` by hand, use the **bare** symbol and re-validate sums (see the `rebalance-portfolio` skill).

## Validate

After any change: snapshots regenerated, `validate-factors.mjs` clean, `portfolios.json` weights still sum to ≈ 1.00, no `.JK` suffixes leaked into `portfolios.json`. For a pinned change, dry-run the optimizer to exercise the ticker gates cheaply:

```bash
cd portfolio-app && node scripts/optimize.mjs --dry-run --emit /tmp/x.json --paths 40 --iterations 400
```
