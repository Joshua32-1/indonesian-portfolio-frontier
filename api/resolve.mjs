/**
 * api/resolve.mjs — GET /api/resolve?symbol=VKTR
 * ─────────────────────────────────────────────────────────────────────────────
 * Cheap existence check for the Add-ticker input: one quoteSummary call, no price
 * history. Lets the UNIVERSE panel confirm a typed name (and show what it resolved
 * to) before the user commits to a full ~130 KB /api/ticker fetch.
 *
 * IDX-only by design — normaliseSymbol() forces the `.JK` suffix, because the sector
 * caps, the IDX transaction-cost model, and the IHSG benchmark all assume IDX names.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isNotFound, normaliseSymbol, toBare, withRetry, yahooFinance } from './_lib/yahoo.mjs';
import { SHORT_CACHE, queryParam, sendJson, withErrorHandling } from './_lib/http.mjs';
import { resolveSectorFromQuoteSummary } from '../portfolio-app/src/math/assetSector.js';

export default withErrorHandling(async (req, res) => {
  const raw = queryParam(req, 'symbol');
  const symbol = normaliseSymbol(raw);
  if (!symbol) {
    return sendJson(res, 400, {
      ok: false,
      error: 'bad_symbol',
      message: 'Enter an IDX ticker, e.g. BBCA (the .JK suffix is added for you).',
    }, SHORT_CACHE);
  }

  let summary;
  try {
    summary = await withRetry(() => yahooFinance.quoteSummary(symbol, {
      modules: ['price', 'assetProfile', 'summaryProfile', 'summaryDetail'],
    }));
  } catch (err) {
    if (isNotFound(err)) {
      return sendJson(res, 404, {
        ok: false,
        error: 'not_found',
        symbol,
        message: `${toBare(symbol)} is not listed on Yahoo as an IDX name.`,
      }, SHORT_CACHE);
    }
    throw err;
  }

  const price = summary.price ?? {};
  // A symbol Yahoo knows but has never priced is not investable — reject it here
  // rather than letting it fail deeper in the fan-out.
  if (price.regularMarketPrice == null && summary.summaryDetail?.regularMarketPrice == null) {
    return sendJson(res, 404, {
      ok: false,
      error: 'no_quote',
      symbol,
      message: `${toBare(symbol)} resolves but has no price data.`,
    }, SHORT_CACHE);
  }

  sendJson(res, 200, {
    ok: true,
    symbol,
    ticker: toBare(symbol),
    name: summary.assetProfile?.longName ?? price.longName ?? price.shortName ?? toBare(symbol),
    sector: resolveSectorFromQuoteSummary(summary),
    currency: price.currency ?? null,
    exchange: price.exchangeName ?? null,
  }, SHORT_CACHE);
});
