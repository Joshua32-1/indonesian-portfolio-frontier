import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(__dirname, '..', 'api');

/**
 * Mounts the real ../api/*.mjs handlers on the Vite dev server so `npm run dev`
 * exercises production code paths without the Vercel CLI. Vercel Node functions use
 * the Node (req, res) signature, so this is a thin Connect adapter.
 *
 * Files starting with `_` are libraries, not routes — the same rule Vercel applies.
 * Handlers are re-imported when their mtime changes, so edits take effect without a
 * dev-server restart.
 */
function devApiPlugin() {
  const cache = new Map(); // route → { mtimeMs, handler }
  return {
    name: 'workbench-dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || '').split('?')[0];
        if (!path.startsWith('/api/')) return next();

        const route = path.slice('/api/'.length);
        if (!/^[a-z0-9-]+$/i.test(route)) return next();

        const file = join(API_DIR, `${route}.mjs`);
        let stat;
        try {
          stat = statSync(file);
        } catch {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ error: 'no_such_route', message: `No handler api/${route}.mjs` }));
        }

        try {
          const hit = cache.get(route);
          let handler = hit && hit.mtimeMs === stat.mtimeMs ? hit.handler : null;
          if (!handler) {
            // Cache-busting query forces a fresh module instance after an edit.
            const mod = await import(`${file}?t=${stat.mtimeMs}`);
            handler = mod.default;
            cache.set(route, { mtimeMs: stat.mtimeMs, handler });
          }
          await handler(req, res);
        } catch (err) {
          server.config.logger.error(`[dev-api] ${route} — ${err.stack || err.message}`);
          if (res.writableEnded) return;
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'handler_threw', message: err?.message ?? String(err) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApiPlugin()],
  server: {
    port: 5176, // 5173 optimizer, 5174 backtest, 5175 dashboard
    open: true,
    // This app composes components from the two sibling app directories, and the
    // backtest engine imports portfolio-app/src/math/* — widen fs access to the
    // monorepo root, exactly as backtest-portfolio/vite.config.js does.
    fs: { allow: ['..'] },
  },
});
