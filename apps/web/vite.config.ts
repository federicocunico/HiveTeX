import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  server: { port: 1420, strictPort: true, proxy: { '/api': { target: 'http://localhost:3000', ws: true } } },
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
