# Proposal

## Why

HiveTeX currently stops a project's peer connections when its workspace is unmounted, so an installed desktop copy cannot keep a project available while its owner is away from the editor. A persistent desktop seed and an end-to-end encrypted fallback through the existing server will keep collaboration available when direct connections fail, while UPnP improves direct connectivity and reduces relay traffic.

The control plane must stay on free hosting tiers and scale as far as they allow; a paid plan is not an option. Measurements in this change showed that any connection held open while idle (a seed waiting on the signaling socket, today's gatekeeper socket) consumes the Vercel Hobby provisioned-memory allowance and the Upstash command allowance regardless of traffic. Therefore an idle device must cost the server nothing: devices wait on a free external push channel and are woken only when another member needs them.

## What Changes

- Zero idle cost ("doorbell"): idle seeds and open clients hold no connection to the server, send no presence heartbeats and renew no tickets. Each running client keeps one subscription to a free, self-hostable push channel (ntfy) for the per-project ring topics of its projects. A member who needs peers asks the server for a short-lived server-signed ring token and publishes it to the project topic; woken devices verify it offline and come online for the introduction only. Signaling sockets exist only while introducing peers (or carrying an application-relay session); the always-on gatekeeper socket is removed.
- Implement the application relay first, using the existing Vercel WebSocket and Upstash infrastructure without requiring a new TURN provider or payment setup. Prefer a healthy direct connection at runtime, then configured (free-tier) TURN; the server relay is a bounded last resort, disabled by default, because its sockets consume the same free allowances.
- Add authenticated relay sessions with separate encryption keys, replay protection, bounded reliable delivery and safe switching between transports. Forward ciphertext only; keep project contents on member devices, with no server-side content archive.
- Enforce server-side byte, message, connection-time and usage budgets, prioritize text/control traffic, and allow binary assets within budget. Surface deferred assets and quota exhaustion rather than claiming full synchronization. Measure invocations, provisioned-memory time, Redis commands and push messages per introduction and per idle hour as part of the free-tier budget.
- Keep the desktop application running in the tray after closing its window; provide open, pause/resume, status and explicit quit actions, single-instance behavior, and configurable launch at login. While nobody needs it the tray app stays dormant: subscribed to its ring topics, with no server traffic.
- Run synchronization independently of the editor webview, with one authoritative runtime per server/account/project and durable storage. Opening a workspace attaches to that runtime.
- Automatically seed locally retained shared projects for owners/editors as dormant seeds reachable on ring; offer per-project disable and explicit download-and-seed for projects not retained locally. Preserve viewer restrictions and keep local-only projects off the network.
- Maintain complete replicas of the known project contents, with bounded background downloads, retry, storage limits, and truthful partial/offline/authorization/conflict states. Continue after network changes and resume from sleep.
- Add native UPnP IGD discovery, owned UDP port mappings, finite lease renewal, gateway-change recovery and cleanup. Integrate verified mappings into native WebRTC ICE; preserve STUN/TURN and browser interoperability.
- Keep foreground typing responsive during background transfers. Seeding does not implicitly activate compilers, GitHub pushes, or background folder editing.
- Migrate existing desktop IndexedDB data with recoverable checkpoints, retain account isolation, and carry forward the completed synchronization-hardening work.

## Capabilities

### New Capabilities

- `desktop-project-seeding`: Desktop lifetime, retained-project policy, durable background runtime, editor attachment, user controls, resource budgets and recovery.
- `automatic-port-mapping`: Native UPnP mapping ownership, lifecycle, ICE integration, fallback and user-visible connectivity diagnostics.

### Modified Capabilities

- `peer-sync`: Add an authenticated application relay on the existing server, transient ciphertext forwarding, recovery and budget controls; zero idle control-plane cost with doorbell wake-up through signed ring tokens; distinguish workspace detachment from stopping synchronization, eligible seed bootstrap, ring-based seed availability and optional UPnP.

## Impact

- Server signaling hub, cross-instance Upstash routing, WebSocket lifecycle, rate limits and deployment documentation; shared protocol, crypto and transport modules; both browser and desktop clients. Additive capability negotiation preserves existing WebRTC peers and deployments.
- A ring endpoint and ring-topic derivation on the server (no new table for idle devices), a push-channel subscriber in both clients, and a dependency on a free push service (ntfy.sh by default, `DOORBELL_URL` for a self-hosted instance). The push service sees opaque topic names, timing and requester IP addresses, never project content, project or user identifiers. The connection manager loses its always-on gatekeeper socket; older clients keep their existing behavior and still interoperate.
- Desktop Rust shell, RTC adapter, keychain integration, process supervision, configuration, installers/updater and cross-platform desktop tests.
- Shared TypeScript synchronization runtime and Persistence interface; a bundled headless JavaScript runtime preserves the existing Yjs protocol while removing dependence on webview timers. Native transactional storage replaces desktop-only IndexedDB ownership through a resumable migration.
- Web workspace/session, account lifecycle, project listing and synchronization status need desktop adapters; the browser retains its existing in-page runtime.
- New tray/autostart/single-instance support, a reviewed UPnP IGD client, transactional local storage and packaged runtime dependencies. No public content server, DHT, anonymous swarm or BitTorrent wire protocol.
- Availability remains conditional on an awake source device, valid authorization, reachable services (including the push channel) and available quotas. Reusing free infrastructure is a deployment constraint, not a guarantee of unlimited traffic or connectivity on every network. UPnP cannot guarantee traversal of CGNAT, double NAT or a host firewall. Waking a dormant seed adds a few seconds to the first connection.

