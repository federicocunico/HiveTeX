import { Hono } from 'hono';
import { handle } from 'hono/vercel';

export const app = new Hono().basePath('/api');
app.get('/health', (c) => c.json({ ok: true }));

export default handle(app);
