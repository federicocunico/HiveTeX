// Vercel Functions (Node.js runtime) call the default export's Web `fetch(request)`, which a Hono app provides.
// The server is bundled by scripts/bundle-api.mjs in the Vercel build command (the workspace packages are TypeScript
// source, which Vercel does not compile inside node_modules).
// @ts-ignore generated at build time
import { createApp } from '../server/dist/vercel.mjs';

export default createApp();
