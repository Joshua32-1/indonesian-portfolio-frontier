/**
 * sync-snapshot.mjs
 * Copies the latest live-market-snapshot.json from portfolio-app into data/.
 * Run: npm run sync-snapshot
 *
 * Designed for local use. CI uses a direct `cp` step in the GitHub Action.
 */

import { copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = join(__dirname, '../../portfolio-app/data/live-market-snapshot.json');
const dest = join(__dirname, '../data/live-market-snapshot.json');

if (!existsSync(src)) {
  console.error(`Source not found: ${src}`);
  console.error('Run: cd portfolio-app && npm run fetch-snapshot');
  process.exit(1);
}

copyFileSync(src, dest);
console.log(`Synced snapshot → live-dashboard-portfolio/data/live-market-snapshot.json`);
const stat = (await import('fs')).statSync(dest);
console.log(`  ${(stat.size / 1024).toFixed(0)} KB  |  written ${stat.mtime.toISOString()}`);
