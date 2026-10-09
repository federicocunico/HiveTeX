import { handle } from 'hono/vercel';
import { createApp } from '../server/src/index.js';

export default handle(createApp());
