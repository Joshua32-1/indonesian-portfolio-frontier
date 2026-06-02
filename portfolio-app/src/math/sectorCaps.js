/** Shared sector concentration cap defaults and helpers. */

export const DEFAULT_SECTOR_CAP = 0.80;
export const MIN_SECTOR_CAP = 0.05;

/** Effective cap for a sector (matches UI slider default). */
export function resolveSectorCap(sectorCaps, sector) {
  const cap = sectorCaps?.[sector] ?? DEFAULT_SECTOR_CAP;
  return Math.max(MIN_SECTOR_CAP, Math.min(1, cap));
}

/** Build cap map for all sectors, preserving user overrides from `existing`. */
export function buildSectorCapsForSectors(sectors, existing = {}) {
  const caps = {};
  for (const sector of sectors) {
    caps[sector] = existing[sector] ?? DEFAULT_SECTOR_CAP;
  }
  return caps;
}

export function hasBindingSectorCaps(sectorGroups, sectorCaps) {
  return Object.keys(sectorGroups).some(
    sector => resolveSectorCap(sectorCaps, sector) < 1 - 1e-8,
  );
}

/** Sum portfolio weights by sector label. */
export function computeSectorWeights(weights, assets) {
  const out = {};
  assets.forEach((asset, i) => {
    out[asset.sector] = (out[asset.sector] ?? 0) + (weights[i] ?? 0);
  });
  return out;
}

/**
 * Per-asset position caps: min(global cap, auto-liq cap, user override).
 * Returns null when no per-asset overrides apply (optimizer uses global cap only).
 *
 * @param {import('./returns.js').Asset[]} assets
 * @param {number} maxPositionCap — global default (0–1)
 * @param {number[]|null} autoCaps — ADT/factor caps aligned to assets
 * @param {Record<string, number>} userCapsByTicker — ticker → max weight fraction
 */
export function mergePositionCaps(assets, maxPositionCap, autoCaps = null, userCapsByTicker = {}) {
  const hasUser = Object.keys(userCapsByTicker).some(
    t => Number.isFinite(userCapsByTicker[t]),
  );
  const hasAuto = autoCaps?.some(c => c < maxPositionCap - 1e-8);
  if (!hasUser && !hasAuto) return null;

  return assets.map((a, i) => {
    let cap = maxPositionCap;
    if (autoCaps?.[i] != null) cap = Math.min(cap, autoCaps[i]);
    const user = userCapsByTicker[a.ticker];
    if (user != null && Number.isFinite(user)) cap = Math.min(cap, user);
    return Math.min(1, Math.max(0, cap));
  });
}
