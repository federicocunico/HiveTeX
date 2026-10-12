import { isApplicationRelayMessage, MAX_RELAY_ENCODED_BYTES, type ApplicationRelayMessage, type TicketClaims } from '@hivetex/protocol';
import type { Deps } from '../deps.js';
import { presenceSid, presenceTicket, type SignalBackend, type UsageMeter, verifyServerTicket } from './hub.js';

/** 'unavailable' means accounting could not be reached: forwarding fails closed with a distinct, retryable error. */
export type RelayDebit = 'ok' | 'limited' | 'unavailable';
export interface RelayAdmission {
  /** Must reserve deployment and principal concurrency before returning; grants never survive this socket. */
  acquire(claims: TicketClaims, sid: string): Promise<{
    /** Debit ingress/backend/egress plus envelope overhead before publishing. */
    debit(bytes: number): Promise<RelayDebit>;
    close(): void;
  } | null>;
}
export interface RelayRouterOptions {
  namespace: string;
  backend: SignalBackend;
  admission: RelayAdmission;
  deps: Pick<Deps, 'now' | 'config'>;
  meter?: UsageMeter;
}
export const relayChannel = (namespace: string, project: string, device: string, sid: string) =>
  'app-relay:' + Buffer.from(JSON.stringify([namespace, project, device, sid])).toString('base64url');

/** Recipient-only ciphertext forwarding. No content queue is persisted in the backend. */
export function createApplicationRelayRouter(o: RelayRouterOptions): NonNullable<Deps['applicationRelay']> {
  if (!o.namespace || o.namespace.length > 128) throw new Error('relay namespace required');
  return {
    async attach(ctx) {
      const credit = await o.admission.acquire(ctx.claims, ctx.sid);
      if (!credit) throw new Error('relay admission unavailable');
      let closed = false, queued = 0, queueCount = 0;
      let unsub: (() => void) | undefined;
      let chain: Promise<unknown> = Promise.resolve();
      const live = () => !closed && ctx.active() && ctx.claims.exp * 1000 > o.deps.now().getTime();
      const close = () => { if (closed) return; closed = true; unsub?.(); credit.close(); };
      const error = (code: string) => { o.meter?.add(`relay.error.${code}`); if (live()) ctx.send({ t: 'relay-error', code, retryAfterMs: 30_000 }); };
      const current = async () => presenceSid((await o.backend.getPresence(ctx.claims.pid))[ctx.claims.dev] ?? '') === ctx.sid;
      try {
        unsub = await o.backend.subscribe(relayChannel(o.namespace, ctx.claims.pid, ctx.claims.dev, ctx.sid), raw => {
          const size = Buffer.byteLength(raw, 'utf8');
          if (!live()) return;
          // Drop overflow for endpoint retransmission. Closing only this subscription leaves the authenticated
          // socket advertising a relay that can never receive again, so a transient burst would become a black hole.
          if (size > MAX_RELAY_ENCODED_BYTES || queued + size > 4 * 1024 * 1024 || queueCount >= 256) { error('relay_backpressure'); return; }
          queued += size; queueCount++;
          chain = chain.then(async () => {
            if (!live()) return;
            const m = JSON.parse(raw) as Record<string, unknown>;
            if (m.t !== 'app-relay' || m.to !== ctx.claims.dev || m.sid !== ctx.sid || typeof m.from !== 'string' || typeof m.fromSid !== 'string' || !isApplicationRelayMessage(m)) return;
            if (await current() && live()) { o.meter?.add('relay.delivered.envelopes'); ctx.send(m); }
          }).catch(() => { error('relay_unavailable'); }).finally(() => { queued -= size; queueCount--; });
        });
        if (!live()) { close(); throw new Error('relay session closed'); }
      } catch (e) { close(); throw e; }
      return {
        close,
        async forward(message: ApplicationRelayMessage) {
          if (!live()) return;
          if (!isApplicationRelayMessage(message) || message.to === ctx.claims.dev) { error('bad_relay_message'); return; }
          try {
            const presence = await o.backend.getPresence(ctx.claims.pid);
            if (!live()) return;
            if (presenceSid(presence[ctx.claims.dev] ?? '') !== ctx.sid) { error('relay_session_replaced'); close(); return; }
            const target = presence[message.to];
            if (!target || presenceSid(target) !== message.sid) { error('relay_peer_unavailable'); return; }
            const claims = await verifyServerTicket(o.deps, presenceTicket(target));
            if (!live() || claims.pid !== ctx.claims.pid || claims.dev !== message.to || claims.exp * 1000 <= o.deps.now().getTime()) { error('relay_peer_unavailable'); return; }
            const payload = JSON.stringify({ t: 'app-relay', to: message.to, sid: message.sid, from: ctx.claims.dev, fromSid: ctx.sid, env: message.env });
            const size = Buffer.byteLength(payload, 'utf8');
            if (size > MAX_RELAY_ENCODED_BYTES) { error('relay_frame_too_large'); return; }
            const debit = await credit.debit(size * 3);
            if (debit !== 'ok') { error(debit === 'unavailable' ? 'relay_accounting_unavailable' : 'relay_limited'); return; }
            if (!live()) return;
            await o.backend.publish(relayChannel(o.namespace, ctx.claims.pid, message.to, message.sid), payload);
            o.meter?.add('relay.forwarded.envelopes');
            o.meter?.add('relay.forwarded.bytes', size);
          } catch { error('relay_unavailable'); }
        },
      };
    },
  };
}
