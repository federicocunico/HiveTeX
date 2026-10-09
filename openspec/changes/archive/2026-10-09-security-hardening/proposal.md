# Proposal

## Why

A security review of the control plane, the peer-to-peer layer and the desktop shell found issues that let a
collaborator (or an outsider with a crafted link) step outside the trust model the project promises:

- an editor can run arbitrary code on the compile leader's machine through a `latexmkrc` file, bypassing the
  shell-escape hardening;
- on MiKTeX (verified locally on MiKTeX 25.4) a document can `\input` any absolute path on the leader's disk and
  the content ends up in the PDF shared with everyone;
- the GitHub OAuth callback does not check who completes the flow, so a link can hand a victim's GitHub token to
  an attacker, silently if the victim already authorized the App;
- an editor can redirect the owner's GitHub backup to another repository the owner can write;
- a demoted member can replay an older ticket to regain write access for up to 15 minutes;
- any script in the desktop webview can bind and read/write arbitrary folders;
- project IDs can be scanned without a global limit, and a viewer can keep the compile leader busy forever.

## What Changes

- **Native compile hardening (desktop)**: run `latexmk` with `-norc`; never write latexmk rc files into the build
  directory; refuse absolute and parent-directory inputs on MiKTeX by setting its unsafe-input/output switches for
  the compile process only (TeX Live already enforces `openin_any=p`).
- **GitHub OAuth binding**: the callback completes only for the same signed-in user and browser that started the
  flow (HttpOnly state cookie + session check); desktop flows bind with a one-time code verifier that only the
  starting device knows (PKCE-style), so a forwarded link cannot complete someone else's flow.
- **Backup binding authority**: the backup writer pushes only to the repository recorded on the control plane by an
  owner (`project.githubRepo`); a binding in the shared project metadata that disagrees is ignored and reported.
- **Ticket refresh monotonicity**: peers accept a refreshed ticket only if it is not older (epoch and issue time)
  than the current one, and keep treating a peer as stale while its epoch is behind.
- **Desktop folder binding**: folders are chosen in a native dialog opened by the Rust side; the webview can no
  longer pass arbitrary paths to the mirror commands. Folder import uses the same picker.
- **Join scanning limit**: in addition to the per-project limit, failed joins are limited per account and per IP
  across all project IDs.
- **Compile-request throttling**: the leader honors at most one recompile request per peer every few seconds and
  skips the build when the project state is unchanged.
- **Signaling identity proof**: connecting to the signaling relay requires signing a server nonce with the device
  key of the ticket, so a member cannot impersonate another member's presence with a copied ticket.
- **Blob transfer bounds**: peers reject blob transfers whose declared size exceeds the project file size limit.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `distributed-compilation`: compile isolation now covers latexmk rc files and MiKTeX path restrictions; recompile
  requests are throttled.
- `github-backup`: linking must be completed by the user and device that started it; the backup target is the
  owner-recorded repository only.
- `project-access`: join attempts are limited across project IDs; revocation cannot be undone by replaying an
  older ticket.
- `peer-sync`: signaling presence requires device-key proof; blob transfers are size-bounded.
- `latex-workspace`: the desktop folder mirror and folder import only use folders picked in a native dialog.

## Impact

- **Desktop (Rust)**: `apps/desktop/src-tauri/src/tex.rs` (latexmk flags, rc filtering, MiKTeX env),
  `lib.rs` + `mirror.rs` (new pick-and-bind command, `mirror_bind` no longer takes a path from JS), capabilities
  file if needed.
- **Web**: `lib/tauri-fs.ts`, `lib/github.ts` (verifier/cookie flow), `ImportDialog` desktop folder import,
  `Workspace` link-folder.
- **Server**: `github.ts` (state cookie, session check, verifier), `projects/routes.ts` (global join limit),
  `signal/hub.ts` (nonce challenge).
- **Sync/compile/github packages**: `connection.ts`/`mesh.ts` (ticket monotonicity), `connect.ts` (signaling
  proof), `blobs.ts` (size bound), `compile/pipeline.ts` (throttle), `github/agent.ts` (binding authority).
- **Protocol**: signaling gains a `challenge` step (server → client nonce, client → signature); old clients cannot
  join the relay after deploy. Acceptable before the first public release.
- No database migration.
