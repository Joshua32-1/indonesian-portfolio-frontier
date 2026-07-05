/**
 * universe.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The definitive IDX large-cap investable universe — the SINGLE SOURCE OF TRUTH
 * for the ticker list, imported by all three apps' fetch scripts:
 *   • portfolio-app/data/fetch-snapshot.js            (optimizer snapshot)
 *   • backtest-portfolio/scripts/fetch-backtest-history.mjs  (walk-forward history)
 *   • live-dashboard-portfolio/scripts/fetch-daily-snapshot.mjs (forward-test tracker)
 *
 * Edit UNIVERSE_JK here and the change propagates to every fetch script — no more
 * hand-syncing three identical arrays. Use the Yahoo `.JK` suffix (e.g. 'GOTO.JK').
 *
 * Pure module: no I/O, no DOM. The dashboard fetch additionally UNIONS in any
 * ticker still referenced in portfolios.json (dropped-but-held names) so their
 * price series keeps flowing to the tracker — see fetch-daily-snapshot.mjs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** IDX tickers to include, Yahoo `.JK` suffix. */
export const UNIVERSE_JK = [
  'BBCA.JK', 'BBRI.JK', 'BMRI.JK', 'TLKM.JK', 'ASII.JK', 'BIRD.JK',
  'INDF.JK', 'ICBP.JK', 'JSMR.JK', 'KLBF.JK', 'SIDO.JK', 'ANTM.JK',
  'BBNI.JK', 'BNGA.JK', 'CMRY.JK', 'PWON.JK', 'AMRT.JK', 'INCO.JK',
  'NCKL.JK', 'MDKA.JK', 'AADI.JK', 'UNTR.JK', 'LSIP.JK', 'CPIN.JK',
  'ISAT.JK',
];

/** 'BBCA.JK' → 'BBCA' (bare symbol used in snapshots & portfolios.json). */
export const toBare = t => t.replace('.JK', '');

/** 'BBCA' → 'BBCA.JK' (Yahoo suffix); idempotent if already suffixed. */
export const toJK = t => (t.endsWith('.JK') ? t : `${t}.JK`);
