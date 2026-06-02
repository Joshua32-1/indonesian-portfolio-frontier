/**
 * simConfig.js
 * Default simulation configuration for robust optimisation options.
 */

/** Default λ — light tail penalty (near-max Sharpe, modest CVaR improvement). */
export const DEFAULT_TAIL_PENALTY = 0.10;

export const DEFAULT_SIM_CONFIG = {
  robustMode:          'tailAware',  // 'tailAware' | 'avgMuSharpe'
  tailPenalty:         DEFAULT_TAIL_PENALTY,
  turnoverPenalty:     0,            // κ: one-way turnover cost (0 = off)
  shrinkage:           true,         // Ledoit-Wolf Σ shrinkage
  optimizerPaths:      1000,         // paths fed to the robust objective (subsample size)
  deterministicStarts: true,         // cap-corner + sector-corner + analytical seeds; no Dirichlet randoms
};
