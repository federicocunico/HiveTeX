export interface Config {
  /** Public origin of the web app, e.g. https://hivetex.vercel.app */
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
  /** Username (lower case) that becomes the first platform admin when it registers or signs in and no admin exists. */
  bootstrapAdmin?: string;
  /** ntfy-compatible push service for doorbell rings (D14); absent disables ringing. */
  doorbellUrl?: string;
  /**
   * Desktop rollout switches (12.3), sent with every ticket: operators can switch background seeding or router port
   * mapping off for all desktops without a release. Foreground sync and stored data are unaffected.
   */
  desktopFeatures?: { background: boolean; upnp: boolean };
}

export const DESKTOP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

/**
 * The app's public origin (email links, secure cookies). Without APP_ORIGIN, a production deployment on Vercel uses the
 * project's stable production domain; other deployments use their own URL.
 */
export function publicOrigin(env: NodeJS.ProcessEnv): string {
  if (env.APP_ORIGIN) return env.APP_ORIGIN;
  if (env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return 'http://localhost:1420';
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const priv = env.TICKET_SIGNING_JWK;
  if (!priv) throw new Error('TICKET_SIGNING_JWK is required');
  const pubs = JSON.parse(env.TICKET_PUBLIC_JWKS ?? '[]') as Config['ticketPublicJwks'];
  const appOrigin = publicOrigin(env);
  return {
    appOrigin,
    extraOrigins: [...DESKTOP_ORIGINS, ...(env.EXTRA_ORIGINS?.split(',').filter(Boolean) ?? [])],
    cookieSecure: appOrigin.startsWith('https://'),
    ticketPrivateJwk: priv,
    ticketKid: env.TICKET_KID ?? 'k1',
    ticketPublicJwks: pubs,
    argon: { memoryCost: 19456, timeCost: 2, parallelism: 1 },
    breachedCheck: env.BREACHED_CHECK !== '0',
    ...(env.BOOTSTRAP_ADMIN?.trim() ? { bootstrapAdmin: env.BOOTSTRAP_ADMIN.trim().toLowerCase() } : {}),
    // Default: the public ntfy.sh instance; DOORBELL_URL points at a self-hosted one, DOORBELL_URL=off disables rings.
    desktopFeatures: { background: env.DESKTOP_BACKGROUND !== 'off', upnp: env.DESKTOP_UPNP !== 'off' },
    ...(env.DOORBELL_URL === 'off' ? {} : { doorbellUrl: (env.DOORBELL_URL || 'https://ntfy.sh').replace(/\/+$/, '') }),
  };
}
