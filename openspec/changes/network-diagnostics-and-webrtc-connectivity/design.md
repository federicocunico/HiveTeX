# Design

## Context

Signaling is a sealed WebSocket relay (`/api/signal`); ICE servers come from `POST /turn` (STUN always, Cloudflare TURN only when keys are set, failure swallowed in `turn.ts`). `RtcLink` in `packages/sync` drives browser/WebView2 and the desktop worker (via Tauri `rtc_*`). Attempts time out at 20 s with backoff; the page only shows `attempt N · lastError`. The investigation (code reading, not yet reproduced) ranks causes: (1) no TURN plus silent STUN-only fallback; (2) answerer drops `ice` envelopes arriving before its link exists (`connect.ts` onEnvelope creates links only on `offer`, while `createLink` awaits ICE config up to 5 s); (3) mDNS/candidate-type mismatches; (4) UDP-blocked/CGNAT; (5) lost unacked signals.

The desktop work this builds on (port mapping, worker, `rtc.rs`, `network.rs`) is uncommitted on `master`; this worktree starts from the last commit.

## Goals / Non-Goals

**Goals:** make every connection failure explainable; reproduce suspect #2 deterministically and fix it; surface TURN status; provide the diagnostics page and peer test.

**Non-Goals:** provisioning TURN; replacing WebRTC; changing signaling transport.

## Decisions

- **Diagnostics collected in `packages/sync`, not the UI.** `RtcLink` records ICE state, candidate types and the selected pair; `connect.ts` records stage and cause per attempt. One source feeds the page, People panel and report. Alternative (UI polls `getStats`) rejected: loses data after failure.
- **Buffer early signals per peer** in the connection manager (queue `ice` envelopes until the link for that peer exists, bounded and expiring with the attempt). Alternative: also create the link on first `ice`; rejected since the offer carries identity/role.
- **TURN status is explicit:** `/turn` returns `relay: {available, reason}` beside the servers; client treats absence as unknown (backward compatible).
- **Probes:** STUN/TURN probes run as throwaway `RTCPeerConnection`s (browser) or via `rtc_*` (desktop), no new dependency. Mapping-type inference is best-effort (two STUN servers compared).
- **Peer test** triggers an immediate retry (Sync now, which resets backoff) and watches the target device's connection state and attempt cause until it connects or the attempt timeout passes. No new worker RPC and no separate probe link, so what the test reports is what real sync experienced.
- **Report redaction** by allow-list of fields, never by filtering a full dump.
- **Reproduce first:** failing deterministic tests (delayed `getIceServers`) before fixes; then verify real behaviour with netlab and a two-browser run. If further root causes appear during the live investigation they are added as tasks.

## Risks / Trade-offs

- [Root cause may be environmental (no TURN)] → the page makes this visible; fix is owner config, recorded in TODO.
- [Probes expose public IP in reports] → report is user-initiated copy; documented.
- [Base differs from in-flight work] → rebase/merge onto the finished apply before touching `rtc.rs`/Tauri commands.
