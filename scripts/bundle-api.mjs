#!/usr/bin/env node
/**
 * Bundles the control plane for the Vercel function (`api/index.ts` imports the result). The workspace packages
 * (@hivetex/*) ship TypeScript source, which Vercel does not compile inside node_modules, so they are inlined here
 * with their own dependencies; the server's direct npm dependencies stay external so Vercel traces them (argon2 is native).
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The server's own npm dependencies stay external (Vercel installs and traces them); everything else is inlined.
const serverDeps = Object.keys(JSON.parse(readFileSync(join(root, 'server/package.json'), 'utf8')).dependencies ?? {}).filter((d) => !d.startsWith('@hivetex/'));
const isServerDep = (p) => serverDeps.some((d) => p === d || p.startsWith(d + '/'));
await build({
  entryPoints: [join(root, 'server/src/index.ts')],
  outfile: join(root, 'server/dist/vercel.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'externalize-server-deps',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          isServerDep(args.path) || args.path.startsWith('node:') ? { path: args.path, external: true } : undefined,
        );
      },
    },
  ],
});
