import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Serve the data/ folder as static assets so fetch('/data/...') works
  publicDir: 'data',
  server: { port: 5173, open: true },
});