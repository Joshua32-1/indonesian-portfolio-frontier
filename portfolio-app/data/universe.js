/**
 * universe.js
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ticker lists, deliberately separate:
 *
 *   UNIVERSE_JK              — the RESEARCH universe. Free to edit. Drives the
 *                              optimizer app and the backtester, and takes effect
 *                              the next time each app's fetch script runs
 *                              (portfolio-app: `npm run dev` / `npm run build`
 *                              via predev; backtest-portfolio: `npm run fetch`).
 *
 *   FORWARD_TEST_UNIVERSE_JK — the PINNED production universe. Frozen. The live
 *                              forward test runs on this list and ONLY this list,
 *                              so editing UNIVERSE_JK can never move production
 *                              mid-experiment.
 *
 * Who reads which:
 *   • portfolio-app/data/fetch-snapshot.js                      → UNIVERSE_JK,
 *       or FORWARD_TEST_UNIVERSE_JK when run with `--forward-test` (CI does this)
 *   • backtest-portfolio/scripts/fetch-backtest-history.mjs     → UNIVERSE_JK
 *   • portfolio-app/scripts/optimize.mjs                        → FORWARD_TEST_UNIVERSE_JK
 *   • live-dashboard-portfolio/scripts/fetch-daily-snapshot.mjs → FORWARD_TEST_UNIVERSE_JK
 *
 * Use the Yahoo `.JK` suffix (e.g. 'GOTO.JK').
 *
 * Pure module: no I/O, no DOM. The dashboard fetch additionally UNIONS in any
 * ticker still referenced in portfolios.json (dropped-but-held names) so their
 * price series keeps flowing to the tracker — see fetch-daily-snapshot.mjs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * RESEARCH universe — optimizer app + backtester. Edit freely; the live forward
 * test does not read this list. Use the Yahoo `.JK` suffix.
 */
export const UNIVERSE_JK = [
  'BBCA.JK', 'BBRI.JK', 'BMRI.JK', 'TLKM.JK', 'ASII.JK', 'BIRD.JK',
  'INDF.JK', 'ICBP.JK', 'JSMR.JK', 'KLBF.JK', 'SIDO.JK', 'ANTM.JK',
  'BBNI.JK', 'BNGA.JK', 'CMRY.JK', 'PWON.JK', 'AMRT.JK', 'INCO.JK',
  'NCKL.JK', 'MDKA.JK', 'AADI.JK', 'UNTR.JK', 'LSIP.JK', 'CPIN.JK',
  'ISAT.JK',
];

/**
 * PINNED forward-test universe — the 25 names the live forward test was launched
 * on (inception 2026-06-30), pinned 2026-08-01.
 *
 * This is a LITERAL copy, not a snapshot of UNIVERSE_JK, so the two lists drift
 * apart the moment UNIVERSE_JK is edited — which is the point. The 300 tracked
 * streams differ only in methodology and κ; changing the opportunity set
 * mid-flight would confound every one of them at once.
 *
 * Frozen at runtime so an accidental push/splice fails loudly instead of quietly
 * widening production.
 *
 * CHANGING THIS LIST IS A DELIBERATE ACT — it starts a new experiment. Before
 * editing, read FORWARD-TEST.md § "Changing the pinned universe": new names need
 * price history back to `portfolios.json → inception` or the dashboard's
 * date-intersection alignment silently rebases every stream's index to 100.
 */
export const FORWARD_TEST_UNIVERSE_JK = Object.freeze([
  'BBCA.JK', 'BBRI.JK', 'BMRI.JK', 'TLKM.JK', 'ASII.JK', 'BIRD.JK',
  'INDF.JK', 'ICBP.JK', 'JSMR.JK', 'KLBF.JK', 'SIDO.JK', 'ANTM.JK',
  'BBNI.JK', 'BNGA.JK', 'CMRY.JK', 'PWON.JK', 'AMRT.JK', 'INCO.JK',
  'NCKL.JK', 'MDKA.JK', 'AADI.JK', 'UNTR.JK', 'LSIP.JK', 'CPIN.JK',
  'ISAT.JK',
]);

/** 'BBCA.JK' → 'BBCA' (bare symbol used in snapshots & portfolios.json). */
export const toBare = t => t.replace('.JK', '');

/** 'BBCA' → 'BBCA.JK' (Yahoo suffix); idempotent if already suffixed. */
export const toJK = t => (t.endsWith('.JK') ? t : `${t}.JK`);
