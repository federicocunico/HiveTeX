import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Server the dev UI talks to through this proxy (`make dev` sets the hosted one; e2e and `make dev-local` use the
// local API). The browser/webview sees same-origin /api, and the server sees its own origin, so its CORS and CSRF
// checks stay strict.
const target = (process.env.HIVETEX_SERVER || 'http://localhost:3000').replace(/\/$/, '');
// The local API trusts the dev page's origin; a remote deployment only trusts its own.
const remote = !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(target);

export default defineConfig({
  plugins: [svelte()],
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@codemirror') || id.includes('node_modules/@lezer')) return 'codemirror';
          if (id.includes('node_modules/yjs') || id.includes('node_modules/lib0') || id.includes('node_modules/y-')) return 'yjs';
        },
      },
    },
  },
});
