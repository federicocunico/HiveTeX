import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { exportJWK, generateKeyPair } from 'jose';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { type Db, schema } from '../src/db/client.js';
import type { Deps } from '../src/deps.js';
import { MemoryMailer } from '../src/mail.js';
import { MemoryRateLimiter } from '../src/ratelimit.js';

export async function makeConfig(): Promise<Config> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const pub = { ...(await exportJWK(publicKey)), alg: 'EdDSA', use: 'sig', kid: 'k1' };
  return {
    appOrigin: 'http://localhost:1420',
    extraOrigins: ['tauri://localhost'],
    cookieSecure: false,
    ticketPrivateJwk: JSON.stringify(await exportJWK(privateKey)),
    ticketKid: 'k1',
    ticketPublicJwks: [{ kid: 'k1', jwk: pub }],
    argon: { memoryCost: 1024, timeCost: 1, parallelism: 1 },
    breachedCheck: false,
  };
}

export async function makeEnv() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const clock = { t: Date.now() };
  const mailer = new MemoryMailer();
  const pending: Promise<unknown>[] = [];
  const deps: Deps = {
    background: (w) => void pending.push(w),
    db: db as unknown as Db,
    limiter: new MemoryRateLimiter(() => clock.t),
    mailer,
    config: await makeConfig(),
    now: () => new Date(clock.t),
  };
  const app = buildApp(deps);
  return { app, deps, db: deps.db, mailer, clock, pending, advance: (ms: number) => {
      clock.t += ms;
    } };
}

export type TestEnv = Awaited<ReturnType<typeof makeEnv>>;

let ipCounter = 0;

// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely-typed JSON
type Json = any;

export class Client {
  cookie = '';
  token = '';
  ip: string;
  constructor(
    private env: TestEnv,
    ip?: string,
  ) {
    ipCounter++;
    this.ip = ip ?? `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.1`;
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = {
      'x-requested-with': 'p2platex',
      'x-forwarded-for': this.ip,
      origin: 'http://localhost:1420',
      ...headers,
    };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookie) h.cookie = this.cookie;
    if (this.token) h.authorization = `Bearer ${this.token}`;
    const res = await this.env.app.request(`/api${path}`, {
      method,
      headers: h,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /^([^=]+)=([^;]*)/.exec(set);
      if (m) this.cookie = m[2] ? `${m[1]}=${m[2]}` : '';
    }
    await Promise.allSettled(this.env.pending.splice(0)); // background work (emails) finishes before the next assertion
    let json: Json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown = {}) => this.req('PATCH', p, b);
  del = (p: string, b?: unknown) => this.req('DELETE', p, b);
}

export const PW = 'correct horse battery staple';

export async function register(env: TestEnv, username: string, opts: { verify?: boolean } = {}) {
  const c = new Client(env);
  const r = await c.post('/auth/register', { username, email: `${username}@example.com`, password: PW });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.json)}`);
  if (opts.verify !== false) {
    const mail = env.mailer.last(`${username}@example.com`);
    const token = /token=([\w-]+)/.exec(mail?.text ?? '')?.[1];
    await c.post('/auth/verify-email', { token });
  }
  return c;
}
