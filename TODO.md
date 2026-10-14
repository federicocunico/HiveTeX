# To do (owner)

## Sync transport (`openspec/changes/reliable-sync-transport`)

In production since 2026-10-14: the application relay starts at once, a direct WebRTC link takes over only after 8 s of
probation, and a link that goes silent hands back to the relay. Production runs with `APPLICATION_RELAY=1` and the
Upstash free-plan profile (`RELAY_PROVIDER_COMMANDS=500000`, `RELAY_BASELINE_COMMANDS=150000`, `RELAY_ENVELOPES=60000`,
`USAGE_LOG=1`; docs/deployment.md section 4).

Checked against production on 2026-10-14 (`SERVER=https://hivetex.vercel.app make sandbox-sync`, deploy `c266362`):
registration, project, join, files and edits both ways and concurrent edits all passed within 1.5 minutes. Production's
`[usage]` line for that minute shows 373 envelopes forwarded through the relay, at about 3.4 Upstash commands each
(752 presence reads, 407 publishes, 98 budget evaluations). Still open:

- **Production 5-minute hold (task 8.2).** The run above was stopped at the start of the hold because the PC ran low on
  memory (Windows Sandbox plus the rest). Rerun it with memory free:
  `SKIP_BUILD=1 SERVER=https://hivetex.vercel.app HOLD_S=300 node apps/desktop/e2e/sandbox-sync.mjs`. Pass: every
  edit arrives within 10 s, and `timeline.txt` shows the relay first and a handover if a direct link survives probation.

- **Long relay without UDP (tasks 2.7, 8.1).** In the sandbox, UDP is blocked, so the pair must stay on the relay for
  the whole hold and keep syncing. Someone must be at the PC to click *Allow* on the sandbox firewall prompt:
  `SKIP_BUILD=1 HOLD_S=300 MATRIX=no-udp node apps/desktop/e2e/sandbox-sync.mjs`. Pass: the route stays `relay`,
  60/60 pings, no `socket.silent`, and both file trees match at the end. Results go to
  `apps/desktop/src-tauri/target/sandbox-sync/<run>/` (`timeline.txt`, `matrix-summary.json`).
- **Two real PCs on different networks (task 8.3).** Install 0.7.3 on both, then on each open Sync > Network diagnostics
  and press *Test connection* and *Test relay only*. Edits must sync within seconds on the relay, and the route may later
  switch to direct. Send *Copy report* from both if anything stalls. This includes the pair from `__conntests.txt`
  (fcunico and belzebub), which failed on 0.7.1.
- **Measure the Upstash baseline (task 6.1).** `RELAY_BASELINE_COMMANDS=150000` is an estimate. After about a week,
  sum `signal.*` and `relay.*` in the `[usage]` lines of the Vercel runtime logs (docs/deployment.md section 4) and set
  the real value.
  Check that the Upstash dashboard stays under 500K commands/month. Presence reads are about 2 per relayed envelope
  (more than half the relay's commands), so caching them briefly in the relay router would roughly halve its cost.
- **Publish 0.7.3.** The version is already bumped on master. Installed 0.7.1 apps still use the old transport and the
  native-only WebRTC path.
- Archive the OpenSpec change once the items above pass.

Optional: a second TURN provider. Cloudflare TURN (`CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`; docs/deployment.md) combines
with the ExpressTURN account already in production. The native stack only uses TURN over UDP (webrtc-rs has no TCP or
TLS TURN, see docs/decisions/native-webrtc.md), so the application relay is what covers UDP-blocked networks.

## Clean-up

- Delete the old tags `v0.1.0` and `v0.1.1` (their releases are already gone):
  `git push origin :refs/tags/v0.1.0 :refs/tags/v0.1.1 && git tag -d v0.1.0 v0.1.1`
- Delete the loose file `expressturn.info` (git-ignored): the ExpressTURN credentials are in `.env.setup` and in Vercel.
- Production test accounts created by `sandbox-sync.mjs` runs against hivetex.vercel.app (`hostA…` / `sbB…` users and
  their `sync-…` projects) can be deleted.

## Verification still to do

Real-device, relay, desktop and router-matrix checks, with exact commands and pass criteria: docs/remaining-verification.md.

## Secrets check (done 2026-10-11)

Nothing private is in the public repository or its history:
- the only tracked env files are templates (`.env.example`) and local-stack defaults (`docker/.env.stack`);
- `.env.setup`, `.env`, `.vercel/` and `expressturn.info` are git-ignored;
- no token or private-key patterns appear in any commit;
- the CI *secrets* job (gitleaks) passes on every push.

Real values live only in Vercel environment variables (including `TURN_*` and the relay settings), GitHub secrets and
the local `.env.setup`.
