/**
 * Resolve a sector/group label from Yahoo quoteSummary payloads.
 * Uses industry (not GICS sector) for finer IDX-relevant groupings
 * e.g. Conglomerates vs Infrastructure Operations vs Railroads.
 *
 * @param {{ assetProfile?: object, summaryProfile?: object }|null|undefined} summary
 * @returns {string}
 */
export function resolveSectorFromQuoteSummary(summary) {
  const ap = summary?.assetProfile ?? {};
  const sp = summary?.summaryProfile ?? {};
  const raw =
    ap.industryDisp ||
    ap.industry ||
    sp.industryDisp ||
    sp.industry ||
    null;
  if (!raw || typeof raw !== 'string') return 'Other';
  return raw.trim() || 'Other';
}
