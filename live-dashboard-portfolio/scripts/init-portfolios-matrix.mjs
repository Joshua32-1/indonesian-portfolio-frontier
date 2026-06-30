#!/usr/bin/env node
/**
 * init-portfolios-matrix.mjs — (re)initialise data/portfolios.json with the EMPTY
 * methodology-matrix skeleton: 10 configs × 6 variants = 60 streams.
 *
 *   config = pert (legacy PERT, BL off) + BL × prior{cap,shrunk,equal} × τ{0.01,0.03,0.10}
 *   variant = max-sharpe, min-var, tail-10/20/35/50
 *   id = `<base>@<configTag>`  (configTag: `pert` or `bl-<prior>-t<NN>`, NN=round(τ·100))
 *
 * SAFETY: refuses to run if any existing entry already has rebalances (won't wipe
 * seeded weights). Delete portfolios.json manually to force a clean re-init.
 *
 * Run: node scripts/init-portfolios-matrix.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../data/portfolios.json');

const INCEPTION = '2026-06-30';
const PRIORS = ['cap', 'shrunk', 'equal'];
const TAUS = [0.01, 0.03, 0.10];
const BASES = [
  { base: 'max-sharpe', label: 'Max Sharpe (Consensus)' },
  { base: 'min-var',    label: 'Min Variance' },
  { base: 'tail-10',    label: 'Tail λ=0.10' },
  { base: 'tail-20',    label: 'Tail λ=0.20' },
  { base: 'tail-35',    label: 'Tail λ=0.35' },
  { base: 'tail-50',    label: 'Tail λ=0.50' },
];
const tauTag = t => String(Math.round(t * 100)).padStart(2, '0');

// configs: pert first, then BL × prior × τ
const configs = [
  { methodology: 'pert', prior: null, tau: null, tag: 'pert' },
  ...PRIORS.flatMap(prior => TAUS.map(tau => ({
    methodology: 'bl', prior, tau, tag: `bl-${prior}-t${tauTag(tau)}`,
  }))),
];

if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  const seeded = (prev.portfolios ?? []).some(p => (p.rebalances ?? []).length > 0);
  if (seeded) {
    console.error('REFUSING: portfolios.json already has rebalance rows. Delete it manually to force a clean re-init.');
    process.exit(1);
  }
}

const portfolios = configs.flatMap(c =>
  BASES.map(b => ({
    id: `${b.base}@${c.tag}`,
    base: b.base,
    methodology: c.methodology,
    prior: c.prior,
    tau: c.tau,
    label: b.label,
    rebalances: [],
  }))
);

const out = {
  _comment: 'Forward-test methodology matrix. config = pert (legacy PERT) + BL × prior{cap,shrunk,equal} × τ{0.01,0.03,0.10}; variant = 6 strategies; id = `<base>@<configTag>`. Frequency (weekly/monthly/quarterly) and gross/net are DERIVED in the dashboard. Append dated rebalance rows per stream (optimize.mjs / weekly cron); never overwrite. Regenerate this skeleton with scripts/init-portfolios-matrix.mjs.',
  inception: INCEPTION,
  updated: INCEPTION,
  riskFreeRate: 0.0575,
  portfolios,
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${portfolios.length} streams (${configs.length} configs × ${BASES.length} variants) → ${OUT}`);
