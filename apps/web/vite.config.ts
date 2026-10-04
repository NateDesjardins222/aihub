import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Extra Host headers Vite will serve, beyond localhost (which Vite always
 * allows). Vite blocks unknown Host headers by default — the protection that
 * stops a stranger's domain from pointing at your dev server. When the dev
 * server is reached through a stable tunnel hostname (e.g.
 * `dev.happytraderfunding.com` via a named Cloudflare Tunnel → :5173), that
 * host must be allow‑listed here or Vite returns "Blocked request. This host
 * is not allowed." Driven by `WEB_ALLOWED_HOST` (comma‑separated) so no hostname
 * is baked into the repo; unset ⇒ `[]` ⇒ localhost‑only. NEVER set to `true`
 * (that would disable host protection entirely).
 */
const allowedHosts = (process.env.WEB_ALLOWED_HOST ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h.length > 0);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    allowedHosts,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  // The same proxy for `vite preview`, so a production build can be profiled
  // against the real API rather than against a mock of it.
  preview: {
    port: 5174,
    host: true,
    allowedHosts,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  // Source maps ship the full unminified frontend source. Off by default so a
  // production deploy does not expose it; opt in with WEB_SOURCEMAP=true when
  // you genuinely need to profile or debug a built bundle (e.g. `vite preview`).
  build: { target: 'es2022', sourcemap: process.env.WEB_SOURCEMAP === 'true' },
});
