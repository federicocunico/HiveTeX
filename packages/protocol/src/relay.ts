/** Additive capability: never sent to a peer/server that did not acknowledge support. */
export const APPLICATION_RELAY_CAPABILITY = 'application-relay-v1';
export const RELAY_SESSION_PREFIX = 'r1_';
export const MAX_RELAY_ENCODED_BYTES = 64 * 1024;
export interface ApplicationRelayMessage {
  t: 'app-relay';
  to: string;
  sid: string;
  /** Opaque endpoint handshake or encrypted envelope, encoded as base64url. */
  env: string;
}
export function supportsApplicationRelay(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 16 && value.includes(APPLICATION_RELAY_CAPABILITY);
}
export function isApplicationRelayMessage(value: unknown): value is ApplicationRelayMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return m.t === 'app-relay' && typeof m.to === 'string' && m.to.length > 0 && m.to.length <= 256 &&
    typeof m.sid === 'string' && /^r1_[A-Za-z0-9_-]{16}$/.test(m.sid) &&
    typeof m.env === 'string' && m.env.length > 0 && m.env.length <= 60 * 1024 && /^[A-Za-z0-9_-]+$/.test(m.env);
}
