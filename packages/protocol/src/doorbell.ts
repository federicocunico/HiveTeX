/** Doorbell (D14): signed, short-lived ring tokens published to a per-project push topic. */
export const RING_TYP = 'hivetex-ring';
/** A ring token is valid this long after it was issued. */
export const RING_TTL_SEC = 60;
/** Where and on which topic a project's devices wait for rings (returned with every ticket). */
export interface DoorbellInfo {
  /** Base URL of the ntfy-compatible push service. */
  url: string;
  /** Opaque per-project, per-epoch topic name: reveals neither project nor user. */
  topic: string;
}
/** The only claims of a ring token: no project, user or device identifiers. */
export interface RingClaims {
  v: 1;
  topic: string;
  ep: number;
  iat: number;
  exp: number;
  /** Random nonce, for replay detection. */
  n: string;
}
export const RING_TOPIC_RE = /^ht[a-z2-7]{26}$/;
