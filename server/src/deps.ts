import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Mailer } from './mail.js';
import type { RateLimiter } from './ratelimit.js';
import type { User } from './db/schema.js';
import type { GithubConfig } from './github.js';
import type { Kv } from './kv.js';
import type { SignalBackend, SocketLike } from './signal/hub.js';
import type { TurnProvider } from './signal/turn.js';

export interface SessionHandlers {
  onMessage(data: string): void | Promise<void>;
  onClose(): void | Promise<void>;
}

export interface Deps {
  db: Db;
  limiter: RateLimiter;
  mailer: Mailer;
  config: Config;
  now: () => Date;
  /** Runs work after the response is sent (Vercel waitUntil) so response timing does not leak whether an email exists. */
  background?: (work: Promise<unknown>) => void;
  /** Ephemeral key/value store (OAuth state, hand-offs). */
  kv?: Kv;
  /** GitHub App credentials; absent => GitHub backup endpoints answer 501. */
  github?: GithubConfig;
  /** Outbound HTTP (injectable for tests). */
  fetch?: typeof fetch;
  /** Cross-instance signaling relay (Upstash in production, in-memory locally). */
  signal?: SignalBackend;
  /** Relay credentials provider; absent => STUN only. */
  turn?: TurnProvider;
  /** Platform WebSocket upgrade (Vercel Functions); absent => /signal answers 426. */
  upgradeWebSocket?: (req: Request, attach: (sock: SocketLike) => SessionHandlers) => Promise<Response> | Response;
}

export interface AuthSession {
  id: string;
  kind: 'web' | 'desktop';
  reauthAt: Date | null;
}

export type Env = {
  Variables: {
    deps: Deps;
    user: User;
    session: AuthSession;
    ip: string;
    requestId: string;
  };
};
