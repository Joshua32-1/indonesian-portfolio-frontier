# IDX Portfolio Workbench

The optimizer and the backtester on **one deployed site**, over an **editable ticker
universe** fetched live from Yahoo Finance.

```bash
npm install && npm install --prefix workbench   # root deps are for /api only
npm run dev --prefix workbench                  # :5176
```

No snapshot needed — the app fetches whatever universe you give it through `/api`, which
the Vite dev server mounts from the same handler files Vercel runs in production.

## What it is (and isn't)

This app **composes** the two existing apps; it does not fork them.
[`src/Shell.jsx`](src/Shell.jsx) imports `portfolio-app/src/App.jsx` and
`backtest-portfolio/src/App.jsx` in place and passes each one its data as a prop. Both
still run standalone against their static files:

| | Standalone | Inside the workbench |
|---|---|---|
| Optimizer (`:5173`) | fetches `/live-market-snapshot.json` | receives a `snapshot` prop |
| Backtester (`:5174`) | fetches `/backtest-history.json` | receives a `history` prop |

Because [`src/universe/marketDataClient.js`](src/universe/marketDataClient.js) rebuilds
those **exact JSON contracts** from the API payloads, neither engine's math changed.

## Editing the universe

The UNIVERSE tab edits the ticker list. Edits are **local to the browser**
(`localStorage`) and never touch the repo.

The default comes from `UNIVERSE_JK` in
[`portfolio-app/data/universe.js`](../portfolio-app/data/universe.js) — the **research**
list, which that file says to "edit freely". The workbench never reads or writes
`FORWARD_TEST_UNIVERSE_JK`, the pinned list the live forward test and the weekly rebalance
run on: changing the opportunity set mid-flight would confound all 300 tracked streams at
once. To change either canonical list, use the
[`add-ticker`](../.claude/skills/add-ticker/SKILL.md) skill.

Adding a name calls `/api/resolve` to validate it, then `/api/ticker` for its history.
Payloads are memoised per symbol, so **removing a ticker costs zero requests and adding
one costs exactly one** — the rest of the universe is reused.

The Reference-backtest panel is **empty on the deployed site**, by design. Those artifacts
are local and gitignored upstream — a committed tearsheet is just a stale copy that goes
out of date the moment a ticker changes, which is doubly true here where the universe is
editable. Generate one locally with `npm run backtest` (or the panel's Regenerate button
under `npm run dev` in `backtest-portfolio/`). The live explorer above it is the part that
tracks your universe.

## The API (`../api/`)

| Route | Returns |
|---|---|
| `GET /api/ticker?symbol=BBCA.JK` | One name: weekly + full daily bars (with `dollarVol`), θ-decay vol, analyst targets, sector, shares out |
| `GET /api/benchmark` | IHSG (`^JKSE`) weekly |
| `GET /api/rf` | The BI-Rate archive — `current` **and** the dated `history` |
| `GET /api/resolve?symbol=VKTR` | Cheap existence/name/sector check for the Add-ticker input |

One name is ~800 ms and ~130 KB, so a 25-name universe loads in ~5 s at concurrency 5.
Responses carry `s-maxage=3600, stale-while-revalidate=3600`: on a **public** deployment
the edge cache — not Yahoo — serves repeat visits, and nobody is ever handed data more
than two hours old. The nav shows the newest bar date, so whatever you get is dated
on screen.

**On "why is this not today's price?"** Yahoo publishes only *settled* bars, so the newest
daily close is normally the **previous** IDX session.

The backtest window tracks the data automatically: the rebalance grid is anchored at the
**newest bar** and steps backwards, so every frequency ends on the most recent week all
included names have a price for. (It used to anchor at the first bar and step forward,
which silently dropped up to 12 weeks off the end at quarterly.) The cost is that the grid
shifts by a bar each week, so two runs a week apart are not directly comparable — see
`rebalanceGrid()` in `backtest-portfolio/src/backtestEngine.js`.

`/api/rf` **reads `portfolio-app/data/bi-rate.json`; it does not scrape BI.** That archive
is the single file every app resolves r_f from, and `refresh-bi-rate.js` is the only thing
that talks to bi.go.id. It returns the whole `history` because the backtest engine scores
each rebalance at the rate in effect on that date — drop the series and it silently
degrades to a constant r_f.

`api/_lib/yahoo.mjs` intentionally **duplicates** the conventions of
`portfolio-app/data/fetch-snapshot.js` and
`backtest-portfolio/scripts/fetch-backtest-history.mjs` rather than being imported by
them: those scripts feed the committed snapshot, the write-once `view-history/` captures,
and four CI workflows. Change a convention in one and mirror it in the others.

## Deploying

New Vercel project on this repo with **Root Directory = repository root** (not a
subdirectory — `workbench/` imports from both sibling app directories, and `/api` must sit
at the root for Vercel to discover it). Everything else is in
[`../vercel.json`](../vercel.json).

The existing `live-dashboard-portfolio` Vercel project is separate and unaffected.
