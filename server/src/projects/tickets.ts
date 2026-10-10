import { SignJWT, importJWK } from 'jose';
import { TICKET_TTL_SEC, TICKET_TYP, type TicketClaims } from '@hivetex/protocol';
import type { Config } from '../config.js';

export type SignableClaims = Omit<TicketClaims, 'iat' | 'exp'>;

export async function signTicket(cfg: Config, claims: SignableClaims, nowSec: number) {
  const key = await importJWK(JSON.parse(cfg.ticketPrivateJwk), 'EdDSA');
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'EdDSA', kid: cfg.ticketKid, typ: TICKET_TYP })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + TICKET_TTL_SEC)
    .sign(key);
}
