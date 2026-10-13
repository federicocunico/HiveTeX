# Proposal

## Why

Two members often cannot reach each other and the app only says "connecting · attempt N · connection attempt timed out". Nobody can tell whether signaling, STUN, TURN, UDP or port mapping is at fault, and the WebRTC link of at least one reported project never comes up. A networking page that proves whether two users see each other and whether ports work is a prerequisite for diagnosing and fixing the WebRTC failure.

## What Changes

- New **Network diagnostics** page (web and desktop) that runs checks and shows the result per step: signaling reachability, ICE configuration obtained (STUN list, whether TURN credentials were issued), STUN reachability and public address, UDP/TURN reachability, UPnP/port-mapping state (desktop), and a live peer test.
- Per co-author "Connection details": ICE connection state, gathered and remote candidate types, selected candidate pair, route (direct/TURN/relay), attempts, failure reason, and a *Copy report* action that omits credentials.
- Peer test: two online members run a short probe link and see whether they connect, with the stage where it stopped.
- Fix of WebRTC connection failures found by the investigation: connection-setup candidates that arrive before the answering side has created its link are currently dropped; a silent STUN-only fallback hides missing TURN credentials; failures give no cause. Reproduce each with a deterministic test first, then fix.
- Surface TURN-not-configured and TURN-mint-failure as explicit diagnostics instead of a silent fallback.

## Capabilities

### New Capabilities
- `network-diagnostics`: the networking page, step checks, per-peer connection details, peer test and shareable report.

### Modified Capabilities
- `peer-sync`: connection-setup messages that arrive early are retained, and a failed connection attempt records a cause (added requirements only).

## Impact

- `packages/sync` (`connect.ts`, `rtc.ts`: early-ICE buffering, candidate/state capture, stage causes), `server/src/signal/turn.ts` (report TURN status), desktop Tauri commands for ICE/candidate/port-mapping status, `apps/web` new view and People panel link.
- Tests: `connect-lifecycle.test.ts`, server signal tests, netlab/e2e.
- Depends on the in-flight desktop work (port mapping, worker, `rtc.rs`) that is still uncommitted on `master`; the `automatic-port-mapping` "Honest connectivity diagnostics" requirement is satisfied by, not changed by, this change.
- Out of scope: operating a TURN service (owner task: Cloudflare keys), changing NAT-traversal strategy beyond the fixes above.
