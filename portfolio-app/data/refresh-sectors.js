/**
 * refresh-sectors.js
 * Updates industry-based sector labels (and company name) on each asset in
 * live-market-snapshot.json from Yahoo Finance — no price history re-fetch.
 *
 * Run: node data/refresh-sectors.js
 */

import YahooFinance from 'yahoo-finance2';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveSectorFromQuoteSummary } from '../src/math/assetSector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const snapPath = join(__dirname, 'live-market-snapshot.json');
const snap = JSON.parse(readFileSync(snapPath, 'utf8'));

console.log(`Refreshing sectors for ${snap.assets.length} assets…\n`);

for (const asset of snap.assets) {
  const yahooTicker = asset.ticker.endsWith('.JK') ? asset.ticker : `${asset.ticker}.JK`;
  try {
    const summary = await yahooFinance.quoteSummary(yahooTicker, {
      modules: ['assetProfile', 'summaryProfile', 'price'],
    });
    const sector = resolveSectorFromQuoteSummary(summary);
    const name = summary.assetProfile?.longName ?? summary.price?.longName ?? asset.name;
    console.log(`  ${asset.ticker.padEnd(6)} ${(asset.sector ?? '?').padEnd(22)} → ${sector}`);
    asset.sector = sector;
    if (name) asset.name = name;
  } catch (err) {
    console.warn(`  ⚠ ${asset.ticker} failed: ${err.message}`);
  }
}

writeFileSync(snapPath, JSON.stringify(snap, null, 2));
console.log(`\n✅ Updated ${snapPath}`);
