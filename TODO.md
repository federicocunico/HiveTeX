# To do (owner)

## Sync transport (`openspec/changes/reliable-sync-transport`)

In production since 2026-10-14: the application relay starts at once, a direct WebRTC link takes over only after 8 s of
probation, and a link that goes silent hands back to the relay. Production runs with `APPLICATION_RELAY=1` and the
Upstash free-plan profile (`RELAY_PROVIDER_COMMANDS=500000`, `RELAY_BASELINE_COMMANDS=150000`, `RELAY_ENVELOPES=60000`,
`USAGE_LOG=1`; docs/deployment.md section 4).

Verified on 2026-10-14:
- **Production 5-minute hold (8.2):** `SERVER=https://hivetex.vercel.app make sandbox-sync` passes. The relay comes first,
  the direct link passes its probation on both sides and takes over, and all 60 edits arrive (median 48 ms). The first
  attempts failed and led to the fixes in 0.8.0: a stale-ticket handover, leftover native connections on the shared UDP
  socket, slow recovery when only one side notices a loss, and TURN routes dying after four minutes (a patched `turn`
  crate, see `apps/desktop/src-tauri/vendor/PATCHES.md`).
- **Long relay holds (2.7):** `MATRIX=relay-stun,no-udp HOLD_S=300 make sandbox-sync` passes. The route stays `relay`
  for 5 minutes, also with UDP blocked, with 0 of 60 edits late. The sandbox now allows the app in its firewall by itself
  (nobody has to click *Allow*).
- **Two PCs on different networks (8.3):** syncing (field report, 0.7.3).

Still open:

- **Matrix scenarios STUN only and TURN with a 5-minute hold (task 8.1):**
  `SKIP_BUILD=1 HOLD_S=300 MATRIX=stun,turn make sandbox-sync`. With TURN, check that the route lasts beyond 4 minutes
  (it died there before the `turn` patch).
- **A 4-device mesh in doorbell mode sometimes never completes** when a newcomer joins an existing mesh of three: peer
  exchange does not always introduce it to everyone within 25 s (happens on 0.7.3 too). Pairs and triples are fine.
  Investigate with a 4-device variant of `server/test/doorbell-e2e.test.ts`.
- **Measure the Upstash baseline (task 6.1).** `RELAY_BASELINE_COMMANDS=150000` is an estimate. After about a week,
  sum `signal.*` and `relay.*` in the `[usage]` lines of the Vercel runtime logs (docs/deployment.md section 4) and set
  the real value.
  Check that the Upstash dashboard stays under 500K commands/month. Presence reads are about 2 per relayed envelope
  (more than half the relay's commands), so caching them briefly in the relay router would roughly halve its cost.
- Archive the OpenSpec change once the items above pass.

## Compilation (0.8.0)

Every device builds its own PDF by default; the shared modes (*Shared*, *Use peers*) are deprecated (docs/compilation.md).
The desktop checks its compiler at every start and repairs it (caches, reinstall, system TeX set aside).
- Decide when to remove the shared modes (and the leader election, `packages/compile` `Election`/`CompileLeader`
  distribution) once no customer relies on them.
- Watch customer reports for the compiler check's *failed* state (Account > Compiler shows the log), to add repair
  steps for the causes seen in the field.

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
