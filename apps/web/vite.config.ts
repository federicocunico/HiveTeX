/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vite';

// Server the dev UI talks to through this proxy (`make dev` sets the hosted one; e2e and `make dev-local` use the
// local API). The browser/webview sees same-origin /api, and the server sees its own origin, so its CORS and CSRF
// checks stay strict.
const target = (process.env.HIVETEX_SERVER || 'http://localhost:3000').replace(/\/$/, '');
// The local API trusts the dev page's origin; a remote deployment only trusts its own.
const remote = !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(target);

export default defineConfig({
  // svelteTesting only acts under Vitest (browser build of Svelte, DOM cleanup between component tests).
  plugins: [svelte(), svelteTesting()],
  // Unit tests (vitest): see packages/sync/vitest.config.ts for why CI needs generous limits and fewer workers.
  test: { testTimeout: 30_000, hookTimeout: 30_000, ...(process.env.CI ? { maxWorkers: 2, minWorkers: 1 } : {}) },
  define: { 'import.meta.env.VITE_DEV_PROXY_TARGET': JSON.stringify(target) },
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      '/api': {
        target,
        ws: true,
        changeOrigin: true,
        secure: true,
        configure: (proxy) => {
          if (!remote) return;
          proxy.on('proxyReq', (req) => req.setHeader('origin', target));
          proxy.on('proxyReqWs', (req) => req.setHeader('origin', target));
        },
      },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    // Fonts stay files: the deployed CSP (vercel.json) allows fonts from 'self' only, never data: URIs.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    rollupOptions: {
      output: {
        manualChunks(id) {
          // y-codemirror.next imports CodeMirror: keeping it out of the yjs chunk keeps the editor off the first load.
          if (id.includes('node_modules/@codemirror') || id.includes('node_modules/@lezer') || id.includes('node_modules/y-codemirror')) return 'codemirror';
          if (id.includes('node_modules/yjs') || id.includes('node_modules/lib0') || id.includes('node_modules/y-')) return 'yjs';
        },
      },
    },
  },
});
