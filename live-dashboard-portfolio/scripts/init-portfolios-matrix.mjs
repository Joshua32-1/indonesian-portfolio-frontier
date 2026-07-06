#!/usr/bin/env node
/**
 * init-portfolios-matrix.mjs — (re)initialise data/portfolios.json with the EMPTY
 * methodology-matrix skeleton: 300 streams = 10 configs × 6 variants × 5 κ.
 *
 *   config  = pert (legacy PERT, BL off) + BL × prior{cap,shrunk,equal} × τ{0.01,0.03,0.10}
 *   variant = max-sharpe, min-var, tail-10/20/35/50
 *   κ       = 0, 0.1, 0.25, 0.5, 0.75  (turnover penalty; forward-test post-hoc blend)
 *   id = `<base>@<configTag>` for κ=0, `<base>@<configTag>-k<KK>` for κ>0 (KK=round(κ·100))
 *        (configTag: `pert` or `bl-<prior>-t<NN>`, NN=round(τ·100))
 *
 * SAFETY: refuses to run if any existing entry already has rebalances (won't wipe
 * seeded weights). Delete portfolios.json manually to force a clean re-init. To ADD
 * the κ>0 streams to an already-seeded file WITHOUT wiping history, use the additive
 * scripts/add-kappa-streams.mjs instead.
 *
 * Run: node scripts/init-portfolios-matrix.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildMatrix, CONFIGS, BASES, KAPPAS } from './lib/kappaExpand.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../data/portfolios.json');

const INCEPTION = '2026-06-30';

if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  const seeded = (prev.portfolios ?? []).some(p => (p.rebalances ?? []).length > 0);
  if (seeded) {
    console.error('REFUSING: portfolios.json already has rebalance rows. Delete it manually to force a clean re-init, or use add-kappa-streams.mjs to add κ streams additively.');
    process.exit(1);
  }
}

const portfolios = buildMatrix();

const out = {
  _comment: 'Forward-test methodology matrix × κ. config = pert (legacy PERT) + BL × prior{cap,shrunk,equal} × τ{0.01,0.03,0.10}; variant = 6 strategies; κ = turnover penalty {0,0.1,0.25,0.5,0.75}; id = `<base>@<configTag>` (κ=0) or `<base>@<configTag>-k<KK>` (κ>0). Frequency (weekly/monthly/quarterly) and gross/net are DERIVED in the dashboard. κ>0 rows are SYNTHESIZED by merge-rebalances.mjs (post-hoc blend toward drift), not hand-authored. Append dated rebalance rows per stream; never overwrite. Regenerate this skeleton with scripts/init-portfolios-matrix.mjs.',
  inception: INCEPTION,
  updated: INCEPTION,
  riskFreeRate: 0.0575,
  portfolios,
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${portfolios.length} streams (${CONFIGS.length} configs × ${BASES.length} variants × ${KAPPAS.length} κ) → ${OUT}`);
