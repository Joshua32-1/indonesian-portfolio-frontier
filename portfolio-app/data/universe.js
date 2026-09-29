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

/* ─────────────────────────────────────────────────────────────────────────────
 * UNIVERSE TIERS — how far out the analyst-view archive reaches
 * ─────────────────────────────────────────────────────────────────────────────
 * The Bloomberg 12-month-target archive (data/analyst-views.json) was extended
 * beyond the 25 research names in three tranches, and every ticker in it carries
 * the tier it entered through:
 *
 *   'core'   UNIVERSE_JK — the 25 names the optimizer and the forward test run on.
 *   'lq45'   LQ45 constituents that were NOT already core, from the
 *            "LQ45 constituents not recorded yet" export.
 *   'broad'  wider IHSG names, from the broad-market export.
 *
 * The tiers are DISJOINT by construction — a ticker is listed once, under the
 * narrowest tier it belongs to — so `[...UNIVERSE_JK, ...LQ45_ADDITIONS_JK,
 * ...BROAD_ADDITIONS_JK]` has no duplicates and the tier reads as a single label.
 * They NEST in meaning: every core name is also an LQ45/IHSG name; every LQ45
 * addition is also an IHSG name. Use `tierAtMost()` when you want that nesting.
 *
 * ⚠️  These lists do NOT change what anything fetches or optimizes. UNIVERSE_JK
 * and FORWARD_TEST_UNIVERSE_JK above are still the only lists the fetch scripts
 * read. The tiers exist so a backtest, a sweep, or the workbench can OPT IN to a
 * wider opportunity set — e.g. `UNIVERSE=$(...) npm run backtest` — and so the
 * archive can say where each name came from.
 *
 * ⚠️  LQ45_ADDITIONS_JK is NOT the LQ45 index. It is the part of LQ45 the archive
 * was missing; the core names that are also LQ45 constituents stay tagged 'core'.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** LQ45 constituents added to the archive that are not in UNIVERSE_JK (25 names). */
export const LQ45_ADDITIONS_JK = Object.freeze([
  'AMMN.JK', 'BRPT.JK', 'GOTO.JK', 'BUMI.JK', 'ADRO.JK', 'INKP.JK',
  'CUAN.JK', 'MBMA.JK', 'PGAS.JK', 'EXCL.JK', 'MAPI.JK', 'UNVR.JK',
  'PTBA.JK', 'ITMG.JK', 'AKRA.JK', 'DEWA.JK', 'ADMR.JK', 'MEDC.JK',
  'EMTK.JK', 'ESSA.JK', 'BBTN.JK', 'PGEO.JK', 'WIFI.JK', 'INDY.JK',
  'HRTA.JK',
]);

/** Broader IHSG names added to the archive, beyond core ∪ LQ45 (36 names). */
export const BROAD_ADDITIONS_JK = Object.freeze([
  'BRMS.JK', 'EMAS.JK', 'TPIA.JK', 'TINS.JK', 'TOWR.JK', 'PANI.JK',
  'HRUM.JK', 'LPKR.JK', 'BELI.JK', 'SILO.JK', 'INTP.JK', 'BTPS.JK',
  'BRIS.JK', 'ACES.JK', 'HMSP.JK', 'GGRM.JK', 'BSDE.JK', 'MAPA.JK',
  'TBIG.JK', 'BFIN.JK', 'AUTO.JK', 'AALI.JK', 'AVIA.JK', 'DSNG.JK',
  'MTEL.JK', 'MYOR.JK', 'SMGR.JK', 'BUKA.JK', 'CTRA.JK', 'MDIY.JK',
  'ERAA.JK', 'TAPG.JK', 'SSIA.JK', 'HEAL.JK', 'ARTO.JK', 'MIKA.JK',
]);


/**
 * FORMER LQ45 constituents that are NOT in any current tier (40 names).
 *
 * These left the index — demoted, delisted, or both — before the 2026 exports the other
 * tiers were built from. They exist for ONE purpose: a point-in-time backtest that
 * reconstitutes its universe from data/index-members.json has to be able to hold a name
 * that was a constituent in 2014 and is gone today. Excluding them is precisely the
 * survivorship bias that cost 0.68 of Sharpe when it was measured (see index-members.js).
 *
 * NOT part of the live opportunity set. Nothing prices these automatically, the optimizer
 * never sees them, and the forward test cannot reach them.
 */
export const HISTORICAL_MEMBERS_JK = Object.freeze([
  'ADHI.JK', 'ASRI.JK', 'BBKP.JK', 'BDMN.JK', 'BHIT.JK', 'BIPI.JK',
  'BJBR.JK', 'BKSL.JK', 'BMTR.JK', 'BNBR.JK', 'BREN.JK', 'BWPT.JK',
  'DOID.JK', 'DSSA.JK', 'ELSA.JK', 'ENRG.JK', 'GIAA.JK', 'IMAS.JK',
  'JPFA.JK', 'KIJA.JK', 'KRAS.JK', 'LPPF.JK', 'MAIN.JK', 'MLPL.JK',
  'MNCN.JK', 'MPPA.JK', 'PTPP.JK', 'SCMA.JK', 'SIMP.JK', 'SMCB.JK',
  'SMRA.JK', 'SRTG.JK', 'SSMS.JK', 'TAXI.JK', 'TKIM.JK', 'VIVA.JK',
  'WIKA.JK', 'WSBP.JK', 'WSKT.JK', 'WTON.JK',
]);

/** Every ticker the analyst-view archive covers: core ++ LQ45 ++ broad (86). */
export const EXTENDED_UNIVERSE_JK = Object.freeze([
  ...UNIVERSE_JK, ...LQ45_ADDITIONS_JK, ...BROAD_ADDITIONS_JK,
]);

/** Every ticker with an archive entry, INCLUDING names that have left the index (126). */
export const ARCHIVE_UNIVERSE_JK = Object.freeze([
  ...EXTENDED_UNIVERSE_JK, ...HISTORICAL_MEMBERS_JK,
]);

/**
 * Tier order, widest last. 'historical' sits outside the nesting the first three describe:
 * core ⊂ lq45 ⊂ broad are progressively wider slices of the CURRENT opportunity set, while
 * 'historical' is names that have left it. tierAtMost('historical') therefore means "every
 * name the archive knows", which is what a point-in-time reconstruction needs and what a
 * live universe selection must never use.
 */
export const UNIVERSE_TIERS = Object.freeze(['core', 'lq45', 'broad', 'historical']);

/** Bare ticker → 'core' | 'lq45' | 'broad'. Frozen; built once from the lists. */
export const UNIVERSE_TIER = Object.freeze(Object.fromEntries([
  ...UNIVERSE_JK.map(t => [toBare(t), 'core']),
  ...LQ45_ADDITIONS_JK.map(t => [toBare(t), 'lq45']),
  ...BROAD_ADDITIONS_JK.map(t => [toBare(t), 'broad']),
  ...HISTORICAL_MEMBERS_JK.map(t => [toBare(t), 'historical']),
]));

/** Tier of a ticker ('BBCA' or 'BBCA.JK'), or null when it is outside the archive. */
export const tierOf = t => UNIVERSE_TIER[toBare(String(t).toUpperCase())] ?? null;

/**
 * The `.JK` tickers up to and including `tier`, in tier order — the NESTING view.
 *   tierAtMost('core')  → 25   tierAtMost('lq45') → 50   tierAtMost('broad') → 86
 */
export function tierAtMost(tier = 'broad') {
  const cut = UNIVERSE_TIERS.indexOf(tier);
  if (cut < 0) throw new Error(`Unknown universe tier: ${tier}`);
  return ARCHIVE_UNIVERSE_JK.filter(t => UNIVERSE_TIERS.indexOf(tierOf(t)) <= cut);
}
