/**
 * sectorColors.js
 * Predefined sector colors plus automatic assignment for any new sector
 * that isn't in the map yet (picks an unused palette color).
 */

export const BASE_SECTOR_COLORS = {
  // Yahoo / GICS-style sectors (auto-fetched)
  'Financial Services':   '#3B82F6',
  'Industrials':          '#EC4899',
  'Energy':               '#F59E0B',
  'Real Estate':          '#8B5CF6',
  'Consumer Defensive':   '#22C55E',
  'Consumer Cyclical':    '#F97316',
  'Healthcare':           '#14B8A6',
  'Technology':           '#6366F1',
  'Communication Services': '#10B981',
  'Basic Materials':      '#A78BFA',
  'Utilities':            '#06B6D4',
  // Legacy manual labels (older snapshots)
  Banking:        '#3B82F6',
  Telecoms:       '#10B981',
  Conglomerate:   '#8B5CF6',
  Transport:      '#EC4899',
  Consumer:       '#F59E0B',
  Infrastructure: '#06B6D4',
  Materials:      '#A78BFA',
  'Food & Beverage': '#22C55E',
  Pharmacy:       '#14B8A6',
  Mining:         '#A78BFA',
  Property:       '#8B5CF6',
  Retail:         '#F97316',
  Other:          '#64748B',
};

/** Colors reserved for auto-assignment — none overlap BASE_SECTOR_COLORS. */
const ASSIGNMENT_PALETTE = [
  '#EF4444', '#F97316', '#22C55E', '#84CC16', '#EAB308',
  '#F472B6', '#6366F1', '#14B8A4', '#D946EF', '#FB7185',
  '#2DD4BF', '#A3E635', '#C084FC', '#38BDF8', '#FB923C',
  '#4ADE80', '#FACC15', '#E879F9', '#67E8F9', '#FCA5A5',
];

const FALLBACK = '#64748B';

function normHex(color) {
  return color?.toUpperCase?.() ?? color;
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60)       [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else              [r, g, b] = [c, 0, x];
  const toByte = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`.toUpperCase();
}

function uniqueGeneratedColor(sector, used) {
  const seed = hashString(sector);
  for (let i = 0; i < 360; i++) {
    const hue = (seed + i * 47) % 360;
    const color = hslToHex(hue, 68, 52);
    if (!used.has(color)) return color;
  }
  return FALLBACK;
}

/**
 * Builds a full sector → color map for the given sector names.
 * Known sectors keep BASE_SECTOR_COLORS; unknown ones get a unique unused color.
 */
export function buildSectorColorMap(sectors) {
  const map = { ...BASE_SECTOR_COLORS };
  const used = new Set(Object.values(map).map(normHex));

  const unknown = [...new Set(sectors)]
    .filter(Boolean)
    .filter(sector => !(sector in map))
    .sort((a, b) => a.localeCompare(b));

  const available = ASSIGNMENT_PALETTE.filter(c => !used.has(normHex(c)));

  for (const sector of unknown) {
    let color;
    if (available.length > 0) {
      const idx = hashString(sector) % available.length;
      color = available[idx];
      available.splice(idx, 1);
    } else {
      color = uniqueGeneratedColor(sector, used);
    }
    map[sector] = color;
    used.add(normHex(color));
  }

  return map;
}

export function getSectorColor(sector, colorMap) {
  return colorMap?.[sector] ?? FALLBACK;
}
