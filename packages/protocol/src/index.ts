export const PROTOCOL_VERSION = 1;

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];
export const canWrite = (r: Role) => r === 'owner' || r === 'editor';

/** Claims in a control-plane-signed membership ticket (compact JWS, EdDSA). */
export interface TicketClaims {
  v: 1;
  pid: string;
  uid: string;
  uname: string;
  dev: string;
  /** Device X25519 public key (base64url), used for E2E signaling envelopes. */
  devX: string;
  /** Device Ed25519 public key (base64url), used to verify peer handshake signatures. */
  devE: string;
  role: Role;
  /** Membership epoch of the project when the ticket was issued. */
  ep: number;
  iat: number;
  exp: number;
}

export const TICKET_TTL_SEC = 15 * 60;
export const TICKET_TYP = 'p2platex-ticket';

export interface TrustedKey {
  kid: string;
  jwk: Record<string, unknown>;
}
export * from './wire.js';
