/**
 * bi-rate-seed.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The HISTORICAL half of the BI-Rate archive: Bank Indonesia policy-rate decisions
 * from 2011 up to the span Bank Indonesia's own rendered table still reaches.
 *
 * Why this file exists: bi.go.id publishes only a rolling recent window of decisions.
 * The backtest walks forward from LISTING_CUTOFF = 2012-01-01 and scores every step at
 * the rate in effect on that date, so a scrape-only archive would flat-extend one rate
 * across a decade — 5.75% applied to the 2013 taper tantrum (7.50%) and to the 2021
 * COVID trough (3.50%) alike. This seed covers the part the scrape cannot.
 *
 * PURE MODULE — no `fs`, no `process`, no DOM. Imported by bi-rate.js, which the
 * backtest engine pulls into the browser via backtestWorker.js.
 *
 * ── PROVENANCE — READ BEFORE CITING ─────────────────────────────────────────
 * These rows are COMPILED FROM PUBLIC RECORD, not scraped from Bank Indonesia. Every
 * row is tagged `source: 'compiled'` and is treated as the LOWEST-precedence input to
 * the archive: any scraped row for the same effective date overwrites it (see
 * SOURCE_RANK in bi-rate.js). The archive therefore self-heals as the scrape reaches
 * back over a date this file also covers.
 *
 * To confirm the rows against Bank Indonesia before relying on them:
 *     cd portfolio-app && node scripts/verify-bi-rate-seed.mjs
 * which scrapes BI and prints a row-by-row agree / disagree / seed-only / BI-only diff.
 * It needs outbound network to www.bi.go.id.
 *
 * Dates are announcement (Board of Governors) dates. A date that is off by a few days
 * mis-rates at most one weekly bar by the size of that move; a wrong LEVEL is the error
 * that matters, and levels are the part of the public record that is least ambiguous.
 *
 * Rows on/after SEED_REVIEW_FROM are the least certain — verify those first.
 *
 * ── THE 19 AUGUST 2016 INSTRUMENT CHANGE ────────────────────────────────────
 * On 19 Aug 2016 Bank Indonesia replaced the old "BI Rate" (a 12-month reference rate,
 * then 6.50%) with the BI 7-Day Reverse Repo Rate (BI7DRR, introduced at 5.25%) as its
 * policy instrument. The 125 bp drop on that date is an INSTRUMENT CHANGE, not an
 * easing decision. BI7DRR was renamed back to "BI-Rate" in 2024 — same instrument,
 * so it keeps the BI7DRR tag here.
 *
 * Splicing the two into one series is what BI, BIS and the commercial data vendors all
 * publish as "the Indonesia policy rate", and it is what this archive does. Each row
 * carries `instrument` so a consumer can see the join. See ASSUMPTIONS.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Policy instrument in force. The tag survives into bi-rate.json. */
export const INSTRUMENT_LEGACY = 'BI_RATE_LEGACY'; // pre-2016 BI Rate (12-month reference)
export const INSTRUMENT_BI7DRR = 'BI7DRR';         // BI 7-Day Reverse Repo Rate (renamed "BI-Rate" 2024)

/** The date the policy instrument changed — the level break is here, not a policy move. */
export const INSTRUMENT_SWITCH_DATE = '2016-08-19';

/** Compiled rows on/after this date are the least certain; verify them first. */
export const SEED_REVIEW_FROM = '2025-01-01';

/**
 * Oldest-first for readability; bi-rate.js normalises order on ingest.
 *
 * Starts in 2011 on purpose: the backtest's earliest query is 2012-01-01, and without a
 * row at-or-before that date rateAsOf() would flat-extend the Feb-2012 rate backwards
 * into the window's first weeks.
 */
export const BI_RATE_SEED = [
  // ── Legacy BI Rate ────────────────────────────────────────────────────────
  // 2011 — anchors the level entering the backtest window.
  { effective: '2011-10-11', rate: 0.0650, instrument: INSTRUMENT_LEGACY },
  { effective: '2011-11-10', rate: 0.0600, instrument: INSTRUMENT_LEGACY },

  // 2012 — cut to what was then a record low, held for ~16 months.
  { effective: '2012-02-09', rate: 0.0575, instrument: INSTRUMENT_LEGACY },

  // 2013 — the taper tantrum: 175 bp of hikes in five months as the rupiah sold off.
  { effective: '2013-06-13', rate: 0.0600, instrument: INSTRUMENT_LEGACY },
  { effective: '2013-07-11', rate: 0.0650, instrument: INSTRUMENT_LEGACY },
  { effective: '2013-08-29', rate: 0.0700, instrument: INSTRUMENT_LEGACY },
  { effective: '2013-09-12', rate: 0.0725, instrument: INSTRUMENT_LEGACY },
  { effective: '2013-11-12', rate: 0.0750, instrument: INSTRUMENT_LEGACY },

  // 2014 — one hike, following the November fuel-subsidy price increase.
  { effective: '2014-11-18', rate: 0.0775, instrument: INSTRUMENT_LEGACY },

  // 2015 — a single cut, then held all year.
  { effective: '2015-02-17', rate: 0.0750, instrument: INSTRUMENT_LEGACY },

  // 2016 — the easing cycle that ran into the instrument change.
  { effective: '2016-01-14', rate: 0.0725, instrument: INSTRUMENT_LEGACY },
  { effective: '2016-02-18', rate: 0.0700, instrument: INSTRUMENT_LEGACY },
  { effective: '2016-03-17', rate: 0.0675, instrument: INSTRUMENT_LEGACY },
  { effective: '2016-06-16', rate: 0.0650, instrument: INSTRUMENT_LEGACY },

  // ── BI 7-Day Reverse Repo Rate ────────────────────────────────────────────
  // 2016-08-19: instrument change. The 6.50% → 5.25% step is NOT an easing decision.
  { effective: '2016-08-19', rate: 0.0525, instrument: INSTRUMENT_BI7DRR },
  { effective: '2016-09-22', rate: 0.0500, instrument: INSTRUMENT_BI7DRR },
  { effective: '2016-10-20', rate: 0.0475, instrument: INSTRUMENT_BI7DRR },

  // 2017 — two cuts in the autumn; held 4.75% for the first three quarters.
  { effective: '2017-08-22', rate: 0.0450, instrument: INSTRUMENT_BI7DRR },
  { effective: '2017-09-22', rate: 0.0425, instrument: INSTRUMENT_BI7DRR },

  // 2018 — 175 bp of defensive hikes through the EM currency stress, incl. two in May.
  { effective: '2018-05-17', rate: 0.0450, instrument: INSTRUMENT_BI7DRR },
  { effective: '2018-05-30', rate: 0.0475, instrument: INSTRUMENT_BI7DRR },
  { effective: '2018-06-29', rate: 0.0525, instrument: INSTRUMENT_BI7DRR },
  { effective: '2018-08-15', rate: 0.0550, instrument: INSTRUMENT_BI7DRR },
  { effective: '2018-09-27', rate: 0.0575, instrument: INSTRUMENT_BI7DRR },
  { effective: '2018-11-15', rate: 0.0600, instrument: INSTRUMENT_BI7DRR },

  // 2019 — four consecutive cuts unwinding most of 2018.
  { effective: '2019-07-18', rate: 0.0575, instrument: INSTRUMENT_BI7DRR },
  { effective: '2019-08-22', rate: 0.0550, instrument: INSTRUMENT_BI7DRR },
  { effective: '2019-09-19', rate: 0.0525, instrument: INSTRUMENT_BI7DRR },
  { effective: '2019-10-24', rate: 0.0500, instrument: INSTRUMENT_BI7DRR },

  // 2020 — COVID easing.
  { effective: '2020-02-20', rate: 0.0475, instrument: INSTRUMENT_BI7DRR },
  { effective: '2020-03-19', rate: 0.0450, instrument: INSTRUMENT_BI7DRR },
  { effective: '2020-06-18', rate: 0.0425, instrument: INSTRUMENT_BI7DRR },
  { effective: '2020-07-16', rate: 0.0400, instrument: INSTRUMENT_BI7DRR },
  { effective: '2020-11-19', rate: 0.0375, instrument: INSTRUMENT_BI7DRR },

  // 2021 — the trough. Held 3.50% from February 2021 to July 2022.
  { effective: '2021-02-18', rate: 0.0350, instrument: INSTRUMENT_BI7DRR },

  // 2022 — the tightening cycle begins in August.
  { effective: '2022-08-23', rate: 0.0375, instrument: INSTRUMENT_BI7DRR },
  { effective: '2022-09-22', rate: 0.0425, instrument: INSTRUMENT_BI7DRR },
  { effective: '2022-10-20', rate: 0.0475, instrument: INSTRUMENT_BI7DRR },
  { effective: '2022-11-22', rate: 0.0525, instrument: INSTRUMENT_BI7DRR },
  { effective: '2022-12-22', rate: 0.0550, instrument: INSTRUMENT_BI7DRR },

  // 2023 — one hike in January, held, then a rupiah-defence hike in October.
  { effective: '2023-01-19', rate: 0.0575, instrument: INSTRUMENT_BI7DRR },
  { effective: '2023-10-19', rate: 0.0600, instrument: INSTRUMENT_BI7DRR },

  // 2024 — April hike, September cut. BI7DRR renamed "BI-Rate" this year.
  { effective: '2024-04-24', rate: 0.0625, instrument: INSTRUMENT_BI7DRR },
  { effective: '2024-09-18', rate: 0.0600, instrument: INSTRUMENT_BI7DRR },

  // ── Least certain block — on/after SEED_REVIEW_FROM. Verify these first. ──
  // 2025 easing cycle.
  { effective: '2025-01-16', rate: 0.0575, instrument: INSTRUMENT_BI7DRR },
  { effective: '2025-05-21', rate: 0.0550, instrument: INSTRUMENT_BI7DRR },
  { effective: '2025-07-16', rate: 0.0525, instrument: INSTRUMENT_BI7DRR },
  { effective: '2025-08-20', rate: 0.0500, instrument: INSTRUMENT_BI7DRR },
  { effective: '2025-09-17', rate: 0.0475, instrument: INSTRUMENT_BI7DRR },
];

/** Human-readable provenance, stamped into bi-rate.json so the file explains itself. */
export const SEED_PROVENANCE = {
  kind: 'compiled',
  note: 'Compiled from public record, NOT scraped from Bank Indonesia. Scraped rows outrank these on a shared effective date. Verify with scripts/verify-bi-rate-seed.mjs.',
  reviewFrom: SEED_REVIEW_FROM,
  instrumentSwitch: INSTRUMENT_SWITCH_DATE,
};
