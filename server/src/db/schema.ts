import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    usernameLc: text('username_lc').notNull().unique(),
    username: text('username').notNull(),
    emailLc: text('email_lc').notNull().unique(),
    email: text('email').notNull(),
    emailVerifiedAt: ts('email_verified_at'),
    pwHash: text('pw_hash').notNull(),
    pwMustReset: boolean('pw_must_reset').notNull().default(false),
    isAdmin: boolean('is_admin').notNull().default(false),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: ts('locked_until'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    kind: text('kind').notNull(), // web | desktop
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    reauthAt: ts('reauth_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const emailTokens = pgTable('email_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(), // verify | reset
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  pwHash: text('pw_hash'),
  defaultRole: text('default_role').notNull().default('viewer'),
  /** owner/repo@branch of the GitHub backup, so joiners can bootstrap when no peer is online (name only, no content). */
  githubRepo: text('github_repo'),
  epoch: integer('epoch').notNull().default(1),
  deletedAt: ts('deleted_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // owner | editor | viewer
    joinedAt: ts('joined_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index('memberships_user_idx').on(t.userId)],
);

export const bans = pgTable(
  'bans',
  {
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    ed25519Pub: text('ed25519_pub').notNull(),
    x25519Pub: text('x25519_pub').notNull(),
    label: text('label').notNull().default(''),
    createdAt: ts('created_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);

export const githubLinks = pgTable('github_links', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  githubLogin: text('github_login').notNull(),
  githubId: bigint('github_id', { mode: 'number' }).notNull(),
});

export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  target: text('target'),
  at: ts('at').notNull().defaultNow(),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
});

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
