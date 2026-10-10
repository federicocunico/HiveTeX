import { describe, expect, it } from 'vitest';
import { createNeonDb, neonOverrides } from '../src/db/client.js';
import { ensureDevTicketKey } from '../src/docker.js';
import { smtpFromEnv } from '../src/mail.js';

describe('local emulator overrides are opt-in', () => {
  it('leaves the Neon driver untouched without NEON_HTTP_ENDPOINT', async () => {
    const { neonConfig } = await import('@neondatabase/serverless');
    const before = neonConfig.fetchEndpoint;
    expect(neonOverrides({})).toBeNull();
    await createNeonDb('postgres://u:p@ep-x.neon.tech/db', {});
    expect(neonConfig.fetchEndpoint).toBe(before);
  });

  it('points the Neon driver at the local proxy when set', async () => {
    const { neonConfig } = await import('@neondatabase/serverless');
    const before = neonConfig.fetchEndpoint;
    try {
      await createNeonDb('postgres://postgres:postgres@db.localtest.me:5432/main', { NEON_HTTP_ENDPOINT: 'http://neon-proxy:4444/sql' });
      expect(neonConfig.fetchEndpoint).toBe('http://neon-proxy:4444/sql');
    } finally {
      neonConfig.fetchEndpoint = before;
    }
  });

  it('uses Gmail exactly as before when SMTP_HOST is unset', () => {
    expect(smtpFromEnv({ GMAIL_USER: 'a@gmail.com', GMAIL_APP_PASSWORD: 'pw' })).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      user: 'a@gmail.com',
      pass: 'pw',
      from: 'a@gmail.com',
    });
    expect(smtpFromEnv({})).toBeNull();
  });

  it('uses an explicit SMTP host (Mailpit) when set', () => {
    expect(smtpFromEnv({ SMTP_HOST: 'mailpit', SMTP_PORT: '1025', GMAIL_USER: 'a@gmail.com', GMAIL_APP_PASSWORD: 'pw' })).toEqual({
      host: 'mailpit',
      port: 1025,
      secure: false,
      from: 'a@gmail.com',
    });
  });

  it('generates a ticket key only for the dev stack', async () => {
    await expect(ensureDevTicketKey({})).rejects.toThrow(/TICKET_SIGNING_JWK/);
    const env: NodeJS.ProcessEnv = { HIVETEX_DEV_STACK: '1' };
    expect(await ensureDevTicketKey(env)).toBe(true);
    expect(JSON.parse(env.TICKET_PUBLIC_JWKS ?? '[]')[0].kid).toBe('dev');
    expect(await ensureDevTicketKey({ TICKET_SIGNING_JWK: '{}' })).toBe(false);
  });
});
