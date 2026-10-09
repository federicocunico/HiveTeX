import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../db/client.js';
import type { Deps } from '../deps.js';
import { randomId, randomToken, sha256 } from '../util.js';
import { hashPassword } from './password.js';
import { revokeAllSessions } from './sessions.js';

export const VERIFY_TTL_MS = 24 * 3600 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;

export async function issueEmailToken(deps: Deps, userId: string, purpose: 'verify' | 'reset') {
  const token = randomToken(32);
  const ttl = purpose === 'verify' ? VERIFY_TTL_MS : RESET_TTL_MS;
  await deps.db.insert(schema.emailTokens).values({
    tokenHash: sha256(token),
    userId,
    purpose,
    expiresAt: new Date(deps.now().getTime() + ttl),
  });
  return token;
}

type Recipient = { id: string; email: string; username: string };

export async function sendVerifyEmail(deps: Deps, user: Recipient) {
  const token = await issueEmailToken(deps, user.id, 'verify');
  await deps.mailer.send({
    to: user.email,
    subject: 'Verify your p2platex email',
    text: `Hi ${user.username},\n\nConfirm your email: ${deps.config.appOrigin}/#/verify?token=${token}\n\nThis link expires in 24 hours.`,
  });
}

export async function sendResetEmail(deps: Deps, user: Recipient) {
  const token = await issueEmailToken(deps, user.id, 'reset');
  await deps.mailer.send({
    to: user.email,
    subject: 'Reset your p2platex password',
    text: `Hi ${user.username},\n\nReset your password: ${deps.config.appOrigin}/#/reset?token=${token}\n\nThis link is single-use and expires in 30 minutes. If you did not request it, ignore this message.`,
  });
}

/** Consumes a single-use token atomically; returns the user id, or null if invalid, expired or used. */
export async function consumeEmailToken(deps: Deps, token: string, purpose: 'verify' | 'reset') {
  const rows = await deps.db
    .update(schema.emailTokens)
    .set({ usedAt: deps.now() })
    .where(
      and(
        eq(schema.emailTokens.tokenHash, sha256(token)),
        eq(schema.emailTokens.purpose, purpose),
        isNull(schema.emailTokens.usedAt),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row || row.expiresAt.getTime() < deps.now().getTime()) return null;
  return row.userId;
}

export async function setPassword(deps: Deps, userId: string, password: string, exceptSession?: string) {
  await deps.db
    .update(schema.users)
    .set({
      pwHash: await hashPassword(password, deps.config.argon),
      pwMustReset: false,
      failedLogins: 0,
      lockedUntil: null,
    })
    .where(eq(schema.users.id, userId));
  await revokeAllSessions(deps, userId, exceptSession);
}

export async function audit(
  deps: Deps,
  actorId: string | null,
  action: string,
  target: string | null,
  meta: object = {},
) {
  await deps.db.insert(schema.auditLog).values({ id: randomId(), actorId, action, target, at: deps.now(), meta });
}
