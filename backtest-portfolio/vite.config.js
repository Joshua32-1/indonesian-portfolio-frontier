import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The walk-forward engine imports pure-JS math from the sibling `portfolio-app`
// (../portfolio-app/src/math/*.js). Vite's dev server sandboxes file access to the
// project root by default, so we widen fs.allow to the monorepo root ('..') so those
// imports resolve. backtest-history.json is served from public/ at runtime.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    open: true,
    fs: { allow: ['..'] },
  },
});
