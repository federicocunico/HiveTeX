export interface Config {
  /** Public origin of the web app, e.g. https://p2platex.vercel.app */
  appOrigin: string;
  /** Extra origins allowed to call the API (desktop webview). */
  extraOrigins: string[];
  cookieSecure: boolean;
  /** Ed25519 private JWK (JSON) used to sign membership tickets. */
  ticketPrivateJwk: string;
  ticketKid: string;
  /** Public JWKs advertised at /api/keys (current + previous for rotation). */
  ticketPublicJwks: { kid: string; jwk: Record<string, unknown> }[];
  /** argon2 tuning; production uses OWASP defaults. */
  argon: { memoryCost: number; timeCost: number; parallelism: number };
  breachedCheck: boolean;
}

export const DESKTOP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const priv = env.TICKET_SIGNING_JWK;
  if (!priv) throw new Error('TICKET_SIGNING_JWK is required');
  const pubs = JSON.parse(env.TICKET_PUBLIC_JWKS ?? '[]') as Config['ticketPublicJwks'];
  const appOrigin = env.APP_ORIGIN ?? (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : 'http://localhost:1420');
  return {
    appOrigin,
    extraOrigins: [...DESKTOP_ORIGINS, ...(env.EXTRA_ORIGINS?.split(',').filter(Boolean) ?? [])],
    cookieSecure: appOrigin.startsWith('https://'),
    ticketPrivateJwk: priv,
    ticketKid: env.TICKET_KID ?? 'k1',
    ticketPublicJwks: pubs,
    argon: { memoryCost: 19456, timeCost: 2, parallelism: 1 },
    breachedCheck: env.BREACHED_CHECK !== '0',
  };
}
