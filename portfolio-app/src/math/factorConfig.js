/**
 * factorConfig.js
 * Default configuration for Black-Litterman + multi-factor risk weighting.
 *
 * τ (tau) and omegaScale are intentionally decoupled:
 *   τ         — scales τΣ (the prior precision). Lower τ → μ_BL anchors toward
 *               cap-weight equilibrium π; higher τ → trusts analyst targets Q more.
 *   omegaScale — sets the absolute uncertainty of each view Ω independently of τ,
 *               so sliding τ actually moves the π-vs-Q blend as expected.
 *
 * IDX context: analyst 12-month targets average ~50pp above equilibrium π
 * (gap ≈ 1.5× annualised σ). τ = 0.03 applies moderate BL shrinkage toward π
 * by default, reflecting structural sell-side optimism on the Indonesian exchange.
 *
 * omegaScale = 0.05 is hardcoded (IDX-calibrated, not exposed as a UI slider):
 *   • Gives 48% shrinkage for BBCA (24 analysts), 83% for WIFI (speculative, 115% Q)
 *   • The academic RMSE-implied value (~0.61) would effectively ignore analyst views;
 *     0.05 is the practical BL convention that preserves meaningful per-stock signal.
 *   • Per-stock differentiation is fully handled by analystConfidence and dispersionOmega.
 */

export const DEFAULT_FACTOR_CONFIG = {
  useFactorModel: false,

  useBlackLitterman: true,
  useCapPrior: true,
  useAnalystViews: true,

  tau: 0.03,           // prior anchor — lower = trust cap equilibrium more (IDX default: conservative)
  omegaScale: 0.05,    // IDX-calibrated, not user-adjustable — see note below
  analystConfidence: 0.7,
  dispersionOmega: 0.8,
  largeCapBias: 0.25,

  useLiquidityRisk: true,

  // Portfolio size drives ADT position caps and Σ liquidity penalty (when > 0)
  portfolioSize: 0,        // total AUM in IDR; 0 = no portfolio-based liquidity
};

/** Merge partial overrides onto defaults. */
export function normalizeFactorConfig(config = {}) {
  return { ...DEFAULT_FACTOR_CONFIG, ...config };
}

/** Whether the factor model is active for this run. */
export function isFactorModelActive(config) {
  return config?.useFactorModel === true;
}

/** Format a compact summary string for Analytics. */
export function formatFactorConfigSummary(config) {
  if (!isFactorModelActive(config)) return 'Factor model OFF (legacy PERT)';

  const parts = [
    `BL τ=${config.tau?.toFixed(3) ?? '0.030'}`,
    `Large-cap bias ${Math.round((config.largeCapBias ?? 0) * 100)}%`,
  ];
  if (config.portfolioSize > 0) {
    const sizeM = Math.round(config.portfolioSize / 1e6).toLocaleString('en-US');
    parts.push(`AUM ${sizeM}M IDR`);
  }
  return parts.join(' · ');
}
