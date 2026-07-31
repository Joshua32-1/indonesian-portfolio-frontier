import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BI_RATE_ARCHIVE = join(__dirname, '..', 'portfolio-app', 'data', 'bi-rate.json');

/**
 * Serve the shared BI-Rate archive at /bi-rate.json.
 *
 * It lives in portfolio-app/data/ (outside this app's root and outside its public/), and it
 * is the ONE file r_f comes from. Serving it live rather than copying means `npm run dev`
 * reflects a rate change the moment the archive is refreshed — no 3 MB backtest-history
 * refetch, and no second copy to drift out of sync. On `vite build` it is emitted into the
 * bundle so a built app keeps working.
 */
function biRateArchive() {
  return {
    name: 'bi-rate-archive',
    configureServer(server) {
      server.middlewares.use('/bi-rate.json', (_req, res) => {
        if (!existsSync(BI_RATE_ARCHIVE)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end('{"error":"bi-rate.json missing — run `npm run refresh-bi-rate` in portfolio-app"}');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store'); // the whole point is picking up a change
        res.end(readFileSync(BI_RATE_ARCHIVE));
      });
    },
    generateBundle() {
      if (!existsSync(BI_RATE_ARCHIVE)) return;
      this.emitFile({ type: 'asset', fileName: 'bi-rate.json', source: readFileSync(BI_RATE_ARCHIVE) });
    },
  };
}

/**
 * Dev-only endpoints behind the Reference-backtest "Generate" button.
 *
 * The reference artifact is the citable tearsheet: the full variant set × all frequencies ×
 * the κ-sweep at high fidelity with a fixed RNG seed. Until now it was rebuildable only from
 * a terminal (`npm run backtest`), over a universe hardcoded to the listing cutoff. These
 * endpoints let the UI rebuild it over the CURRENT selection instead — which matters because
 * universe.js is not frozen, so "the 19 long-history names" is not a stable definition.
 *
 * It SPAWNS THE EXISTING SCRIPT rather than re-running the engine in the browser worker.
 * That keeps exactly one code path for the artifact, so a run from the button and a run from
 * the terminal are byte-identical at the same seed — the property the whole "frozen,
 * reproducible, citable" framing rests on.
 *
 * Dev-only on purpose: it spawns a process and writes into public/. The backtest app is a
 * local research tool (see CLAUDE.md) and is never deployed, but registering these in
 * configureServer means they cannot exist in a built bundle regardless.
 *
 *   POST /__reference/generate  { universe, prior, seed, paths, maxIter, freqs } → { ok, pid }
 *   GET  /__reference/status                                                     → { running, log, … }
 *   POST /__reference/cancel                                                     → { ok }
 */
function referenceGenerator() {
  // One job at a time: a full sweep is minutes-to-an-hour of CPU, and two concurrent runs
  // would race on the same output file.
  let job = null; // { child, log[], startedAt, universe, prior, exitCode, canceled }

  const json = (res, code, body) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });

  return {
    name: 'reference-generator',
    configureServer(server) {
      server.middlewares.use('/__reference/status', (_req, res) => {
        if (!job) return json(res, 200, { running: false, idle: true, log: [] });
        json(res, 200, {
          running: job.exitCode === null && !job.canceled,
          idle: false,
          startedAt: job.startedAt,
          universe: job.universe,
          prior: job.prior,
          exitCode: job.exitCode,
          canceled: job.canceled,
          log: job.log.slice(-400), // enough to carry the metrics table the script prints
        });
      });

      server.middlewares.use('/__reference/cancel', (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (!job || job.exitCode !== null) return json(res, 200, { ok: true, note: 'nothing running' });
        job.canceled = true;
        job.child.kill('SIGTERM');
        job.log.push('', '⛔  Canceled. The artifact already on disk is untouched.');
        json(res, 200, { ok: true });
      });

      server.middlewares.use('/__reference/generate', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (job && job.exitCode === null && !job.canceled) {
          return json(res, 409, { error: 'A generation is already running.' });
        }

        let body;
        try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

        // Validate before it reaches a spawned process: UNIVERSE is passed through the
        // environment, so only plain ticker symbols are allowed through.
        const universe = Array.isArray(body.universe)
          ? body.universe.filter(t => typeof t === 'string' && /^[A-Z0-9]{2,10}$/i.test(t))
          : [];
        if (universe.length < 2) return json(res, 400, { error: 'Need at least 2 valid tickers.' });

        const prior = ['cap', 'shrunk', 'equal'].includes(body.prior) ? body.prior : 'cap';
        const freqs = Array.isArray(body.freqs) && body.freqs.length
          ? body.freqs.filter(f => ['weekly', 'monthly', 'quarterly'].includes(f))
          : ['weekly', 'monthly', 'quarterly'];
        if (!freqs.length) return json(res, 400, { error: 'No valid frequency selected.' });

        const int = (v, d, lo, hi) => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
        };

        const env = {
          ...process.env,
          UNIVERSE: universe.join(','),
          PRIOR: prior,
          FREQS: freqs.join(','),
          SEED: String(int(body.seed, 12345, 0, 2 ** 31 - 1)),
          PATHS: String(int(body.paths, 100, 10, 2000)),
          MAXITER: String(int(body.maxIter, 35, 5, 200)),
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=2048`.trim(),
        };

        const child = spawn(process.execPath, ['scripts/run-strategy-backtest.mjs'], {
          cwd: __dirname,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        job = {
          child,
          log: [`▶  ${universe.length} names · prior=${prior} · freqs=${freqs.join(',')} · seed=${env.SEED} · paths=${env.PATHS}`, ''],
          startedAt: new Date().toISOString(),
          universe,
          prior,
          exitCode: null,
          canceled: false,
        };

        const capture = (buf) => {
          for (const line of String(buf).split('\n')) job.log.push(line);
          if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
        };
        child.stdout.on('data', capture);
        child.stderr.on('data', capture);
        child.on('close', (code) => {
          job.exitCode = code ?? -1;
          if (!job.canceled) job.log.push('', code === 0 ? '✅  Artifact written.' : `❌  Exited ${code}.`);
        });
        child.on('error', (err) => {
          job.exitCode = -1;
          job.log.push('', `❌  Could not start: ${err.message}`);
        });

        json(res, 202, { ok: true, pid: child.pid, universe: universe.length, prior });
      });
    },
  };
}

// The walk-forward engine imports pure-JS math from the sibling `portfolio-app`
// (../portfolio-app/src/math/*.js). Vite's dev server sandboxes file access to the
// project root by default, so we widen fs.allow to the monorepo root ('..') so those
// imports resolve. backtest-history.json is served from public/ at runtime.
export default defineConfig({
  plugins: [react(), biRateArchive(), referenceGenerator()],
  server: {
    port: 5174,
    open: true,
    fs: { allow: ['..'] },
  },
});
