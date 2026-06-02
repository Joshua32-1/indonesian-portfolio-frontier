/**
 * qualityFactors.js
 * Per-asset factor scores, cap weights, position caps, and BL inputs.
 */

import { isFactorModelActive } from './factorConfig.js';
import { mergePositionCaps } from './sectorCaps.js';
import { computeDispersion } from './returns.js';
import {
  buildBlackLittermanContext,
  computePosteriorReturns,
  computeViewUncertainty,
} from './blackLitterman.js';

function log1p(x) {
  return Math.log1p(Math.max(0, x ?? 0));
}

function minMaxNormalize(values) {
  const finite = values.map(v => (Number.isFinite(v) ? v : null));
  const valid = finite.filter(v => v != null);
  if (valid.length === 0) return values.map(() => 0.5);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  if (Math.abs(max - min) < 1e-12) return values.map(v => (v == null ? 0.5 : 1));
  return finite.map(v => (v == null ? 0.5 : (v - min) / (max - min)));
}

function median(values) {
  const sorted = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function resolveMarketCap(asset, medians) {
  const v = asset.meta?.marketCap;
  return Number.isFinite(v) && v > 0 ? v : medians.marketCap;
}

function resolveTurnover(asset, medians) {
  const direct = asset.meta?.avgDailyTurnover;
  if (Number.isFinite(direct) && direct > 0) return direct;
  const vol = asset.meta?.averageVolume;
  const px = asset.meta?.currentPrice;
  if (Number.isFinite(vol) && vol > 0 && Number.isFinite(px) && px > 0) return vol * px;
  return medians.turnover;
}

/** Implied total return from a price target. */
export function impliedReturnFromTarget(asset, targetPrice) {
  const px = asset.meta?.currentPrice;
  if (!px || px <= 0 || targetPrice == null) return 0;
  const div = asset.meta?.dividendYield ?? 0;
  return (targetPrice - px) / px + div;
}

/** Mean-target view return Q_i. */
export function meanViewReturn(asset) {
  return impliedReturnFromTarget(asset, asset.forwardEstimates?.meanTarget);
}

/**
 * Computes factor inputs for the active universe.
 * @returns {{
 *   perAsset: Array<{
 *     dispersion, liquidityScore, maturityScore, capWeight,
 *     totalAnalysts, viewReturn
 *   }>,
 *   capWeights: number[],
 *   maxAnalysts: number,
 * }}
 */
export function computeQualityFactors(assets, factorConfig) {
  const n = assets.length;
  const medians = {
    marketCap: median(assets.map(a => a.meta?.marketCap)),
    turnover: median(assets.map(a => {
      const direct = a.meta?.avgDailyTurnover;
      if (Number.isFinite(direct) && direct > 0) return direct;
      const vol = a.meta?.averageVolume;
      const px = a.meta?.currentPrice;
      return vol && px ? vol * px : null;
    })),
  };

  const rawMcap = assets.map(a => {
    const m = resolveMarketCap(a, medians);
    return Number.isFinite(m) && m > 0 ? m : 1;
  });

  const rawTurnover = assets.map(a => {
    const t = resolveTurnover(a, medians);
    return Number.isFinite(t) && t > 0 ? t : medians.turnover ?? 1;
  });

  const liquidityInputs = rawTurnover.map(t => log1p(t));
  const maturityInputs = rawMcap.map(m => log1p(m));

  const turnoverScores = minMaxNormalize(liquidityInputs);
  const floatInputs = assets.map(a => {
    const f = a.meta?.freeFloatPct;
    return Number.isFinite(f) && f > 0 ? f : null;
  });
  const hasFloat = floatInputs.some(f => f != null);
  const floatScores = hasFloat
    ? minMaxNormalize(floatInputs.map(f => (f != null ? f : 0.5)))
    : null;
  const liquidityScores = hasFloat
    ? turnoverScores.map((s, i) => 0.7 * s + 0.3 * floatScores[i])
    : turnoverScores;
  const maturityScores = minMaxNormalize(maturityInputs);

  const maxAnalysts = Math.max(1, ...assets.map(a => a.forwardEstimates?.totalAnalysts ?? 0));

  const cfg = factorConfig ?? {};
  const active = isFactorModelActive(cfg);

  let exponent = 1;
  if (active && cfg.useCapPrior !== false) {
    exponent = 1 - 2 * (cfg.largeCapBias ?? 0);
  } else if (active) {
    exponent = 0;
  }

  const rawCapWeights = rawMcap.map(m => Math.pow(m, exponent));
  const capSum = rawCapWeights.reduce((s, v) => s + v, 0);
  const capWeights = capSum > 0
    ? rawCapWeights.map(v => v / capSum)
    : Array(n).fill(1 / n);

  const perAsset = assets.map((asset, i) => {
    const dispersion = computeDispersion(asset);
    const totalAnalysts = asset.forwardEstimates?.totalAnalysts ?? 0;
    const viewReturn = meanViewReturn(asset);

    return {
      dispersion,
      liquidityScore: liquidityScores[i],
      maturityScore: maturityScores[i],
      capWeight: capWeights[i],
      totalAnalysts,
      viewReturn,
    };
  });

  return { perAsset, capWeights, maxAnalysts, priorExponent: exponent };
}

/**
 * Auto-derives per-stock position caps and a global liquidityPenalty from
 * actual portfolio size vs each stock's average daily turnover (ADT).
 *
 * Safe position = 10% of ADT × 5 trading days (standard market-impact rule).
 * Position cap for stock i = safeMaxIDR_i / portfolioSize, clamped to [2%, globalCap].
 *
 * liquidityPenalty is derived from the most-stressed name in the universe:
 *   stressRatio < 0.05  → 0.0  (no concern)
 *   0.05 – 0.10         → 0.3
 *   0.10 – 0.20         → 0.5
 *   0.20 – 0.50         → 0.7
 *   > 0.50              → 0.9
 *
 * @param {Array}  assets
 * @param {number} portfolioSize  total AUM in IDR
 * @param {number} maxPositionCap global weight ceiling (0-1)
 * @returns {{ positionCaps, liquidityPenalty, stressRatios, safeMaxIDR }}
 */
export function computeAutoLiquidityCaps(assets, portfolioSize, maxPositionCap = 1) {
  const n = assets.length;
  const equalWeight = 1 / n;

  const safeMaxIDR = assets.map(a => {
    const adt = a.meta?.avgDailyTurnover ?? 0;
    return adt > 0 ? adt * 0.10 * 5 : null;  // 10% of ADT, 5-day window
  });

  const stressRatios = assets.map((a, i) => {
    const adt = a.meta?.avgDailyTurnover ?? 0;
    if (!adt || adt <= 0) return 0;
    return (portfolioSize * equalWeight) / adt;
  });

  const positionCaps = assets.map((a, i) => {
    if (!safeMaxIDR[i] || portfolioSize <= 0) return maxPositionCap;
    const derived = safeMaxIDR[i] / portfolioSize;
    return Math.max(0.02, Math.min(maxPositionCap, derived));
  });

  const maxStress = Math.max(0, ...stressRatios.filter(r => r > 0));
  let liquidityPenalty = 0;
  if      (maxStress >= 0.50) liquidityPenalty = 0.9;
  else if (maxStress >= 0.20) liquidityPenalty = 0.7;
  else if (maxStress >= 0.10) liquidityPenalty = 0.5;
  else if (maxStress >= 0.05) liquidityPenalty = 0.3;

  return { positionCaps, liquidityPenalty, stressRatios, safeMaxIDR };
}

/**
 * When portfolio size is set, derives ADT position caps and a global liquidityPenalty
 * from AUM vs turnover. Per-stock Σ inflation still uses liquidityScore in augmentCovarianceMatrix.
 */
export function resolvePortfolioLiquidity(assets, factorConfig, maxPositionCap = 1) {
  const portfolioSize = factorConfig?.portfolioSize ?? 0;
  if (portfolioSize <= 0) {
    return { autoLiq: null, effectiveConfig: factorConfig, positionCaps: null };
  }

  const autoLiq = computeAutoLiquidityCaps(assets, portfolioSize, maxPositionCap);
  const applyLiqRisk = factorConfig.useLiquidityRisk !== false;
  const effectiveConfig = {
    ...factorConfig,
    liquidityPenalty: applyLiqRisk ? autoLiq.liquidityPenalty : 0,
  };

  return {
    autoLiq,
    effectiveConfig,
    positionCaps: autoLiq.positionCaps,
  };
}

/** Preview rows for Workspace factor table. */
export function computeFactorPreview(assets, covMatrix, factorConfig, maxPositionCap, riskFreeRate, userPositionCaps = {}) {
  const { autoLiq, effectiveConfig, positionCaps } = resolvePortfolioLiquidity(
    assets, factorConfig, maxPositionCap,
  );
  const mergedCaps = mergePositionCaps(assets, maxPositionCap, positionCaps, userPositionCaps);
  const factors = computeQualityFactors(assets, effectiveConfig);
  const effCapFor = (i) => (mergedCaps ? mergedCaps[i] : maxPositionCap);

  if (!isFactorModelActive(factorConfig) || !covMatrix?.length) {
    return {
      factors,
      autoLiq,
      rows: assets.map((asset, i) => ({
        ticker: asset.ticker,
        priorWt: factors.capWeights[i],
        viewQ: factors.perAsset[i].viewReturn,
        omega: null,
        muBL: factors.perAsset[i].viewReturn,
        liquidityScore: factors.perAsset[i].liquidityScore,
        maturityScore: factors.perAsset[i].maturityScore,
        effCap: effCapFor(i),
        stressRatio: autoLiq?.stressRatios[i] ?? null,
        safeMaxIDR: autoLiq?.safeMaxIDR[i] ?? null,
      })),
    };
  }

  const blContext = buildBlackLittermanContext({
    assets,
    covMatrix,
    capWeights: factors.capWeights,
    factorConfig: effectiveConfig,
    maxAnalysts: factors.maxAnalysts,
    riskFreeRate,
  });
  const omega = computeViewUncertainty(assets, covMatrix, effectiveConfig, factors.maxAnalysts);
  const Q = factors.perAsset.map(p => p.viewReturn);
  const muBL = computePosteriorReturns(Q, covMatrix, blContext);

  return {
    factors,
    blContext,
    autoLiq,
    rows: assets.map((asset, i) => ({
      ticker: asset.ticker,
      priorWt: factors.capWeights[i],
      viewQ: Q[i],
      omega: omega[i],
      muBL: muBL[i],
      liquidityScore: factors.perAsset[i].liquidityScore,
      maturityScore: factors.perAsset[i].maturityScore,
      effCap: effCapFor(i),
      stressRatio: autoLiq?.stressRatios[i] ?? null,
      safeMaxIDR: autoLiq?.safeMaxIDR[i] ?? null,
    })),
  };
}
