import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
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
