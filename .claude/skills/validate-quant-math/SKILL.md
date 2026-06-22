---
name: validate-quant-math
description: Run portfolio-app/scripts/validate-factors.mjs and interpret the legacy-vs-tail-aware / Black-Litterman / shrinkage regression output. Use after editing any src/math/ module, or to confirm the engine still behaves as documented in ASSUMPTIONS.md.
---

# Validate quant math

The regression suite is the first gate after any change to the optimizer's math engine.

## Run

```bash
cd portfolio-app
node scripts/validate-factors.mjs
```

It loads the committed snapshot, builds ρ and Σ over 2023–2024, then runs three configurations on 12 assets (500 iterations for speed):

1. **Legacy** — `avgMuSharpe`, factor model off, no shrinkage.
2. **Tail-aware default** — `tailAware`, `tailPenalty: 0.10`.
3. **Factor model on** — `DEFAULT_FACTOR_CONFIG` with `useFactorModel: true` (Black-Litterman + liquidity).

## How to interpret

- **It must complete without throwing.** A thrown error (singular matrix, NaN, failed Cholesky) is a hard fail — usually a covariance/shrinkage or BL-inversion regression.
- **Sanity-check the printed portfolios against `ASSUMPTIONS.md`:**
  - Weights are long-only and sum to ~1.
  - Tail-aware vs. legacy should differ in CVaR/tail metrics, not produce identical allocations.
  - Factor-model-on should show BL shrinkage moving returns toward the cap-weight prior (analyst optimism discounted), not blow up.
  - Sharpe values are finite and reasonable given `riskFreeRate`.
- **For a more thorough check**, bump `ITERS` in the script to ~5000 locally (don't commit that).

## If it fails

- Re-read the changed `src/math/` file against the formulas in `portfolio-app/README.md` and the constants in `API.md`.
- Consider invoking the `quant-math-reviewer` agent for a line-by-line check.
- Do not mark math work complete while this suite fails (see `CONTRIBUTING.md`).
