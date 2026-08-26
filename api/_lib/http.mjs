/**
 * api/_lib/http.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Response helpers shared by the workbench serverless functions. Files under api/
 * whose name starts with `_` are NOT routed by Vercel.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Edge-cache policy for market data. Caching is what keeps a PUBLIC deployment from
 * hammering Yahoo — a repeat visitor's fan-out is served from the Vercel edge, not
 * upstream — but it is also the only thing that can make a "live" page show old numbers,
 * so the window is deliberately short.
 *
 * 1 h fresh, then served stale for at most 1 h more while revalidating in the background.
 * Intraday fields (currentPrice, analyst targets) therefore track within ~an hour, and a
 * visitor can never be handed data older than two hours. The UI shows the newest bar date
 * regardless, so whatever they get is dated on screen.
 *
 * Raising these trades freshness for upstream-call volume; don't raise them without also
 * making the staleness visible.
 */
export const MARKET_CACHE = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600';

/** Validation failures are cheap and symbol-specific — cache them briefly too. */
export const SHORT_CACHE = 'public, max-age=0, s-maxage=300';

/** @param {import('http').ServerResponse} res */
export function sendJson(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheControl) res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(body));
}

/**
 * Wraps a handler so every unexpected throw becomes a structured JSON error rather
 * than an opaque 500 HTML page — the client surfaces `error` directly in the UI.
 * @param {(req, res) => Promise<void>} handler
 */
export function withErrorHandling(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.headersSent || res.writableEnded) return;
      sendJson(res, 502, {
        error: 'upstream_failed',
        message: err?.message ?? String(err),
      });
    }
  };
}

/** Reads a query param from either a Vercel `req.query` or a raw Node request URL. */
export function queryParam(req, name) {
  if (req.query && typeof req.query === 'object') {
    const v = req.query[name];
    if (v != null) return Array.isArray(v) ? v[0] : v;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get(name);
}
