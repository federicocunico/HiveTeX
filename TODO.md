# To do (owner)

## Release clean-up (optional)

- Delete the old tags `v0.1.0` and `v0.1.1` (their releases are already gone):
  `git push origin :refs/tags/v0.1.0 :refs/tags/v0.1.1 && git tag -d v0.1.0 v0.1.1`

## Peer-to-peer (user report, project `df72heljrgs56wmo`)

- Ask the user to update both devices to v0.2.1 and, if a device stays on *connecting*, to send what the Sync panel
  shows. Without a relay (no TURN by choice), two networks that cannot reach each other directly cannot sync.
- 2026-10-11 investigation: this PC's network is not the problem (outbound UDP to STUN/TURN works, the TURN TCP/TLS
  ports 3478/5349/443 are open, the NAT keeps one port for every destination, Windows Firewall blocks nothing). Most
  likely the other device's network does not accept a direct link and there is no TURN relay. Still to collect: the
  error after "attempt N" in People, and the other device's network and app version.
- Turn on the TURN relay (the code is already there; it is only used when a direct link fails, and it forwards traffic
  that is already end-to-end encrypted):
  1. Cloudflare dashboard → **Realtime** → **TURN** → create a TURN key
     ([docs](https://developers.cloudflare.com/realtime/turn/)). Copy its **key ID** and **API token** (the token is
     shown only once). The free tier is enough.
  2. Store both on the Vercel project, Production environment, either way:
     - `npx vercel@latest env add CF_TURN_KEY_ID production`, then `npx vercel@latest env add CF_TURN_API_TOKEN production`
       (or Vercel dashboard → project → Settings → Environment Variables);
     - or put `CF_TURN_KEY_ID=` / `CF_TURN_API_TOKEN=` in `.env.setup` and re-run `make setup` (safe: it keeps
       existing secrets and redeploys).
  3. Redeploy so the server reads them (environment variables apply only to new deployments): GitHub → Actions →
     **Deploy** → *Run workflow* on `master`, or `npx vercel@latest --prod`. `make setup` already redeploys.
  4. Check: open a project in the web app, DevTools → Network → the `turn` request. Its `iceServers` must include
     `turn:` / `turns:` URLs, not only the two `stun:` ones. If they are missing, the keys are wrong: the server then
     answers with STUN only and does not report the error (`server/src/signal/turn.ts`).
  5. On both devices of `df72heljrgs56wmo`: **Sync now** and confirm that People shows the co-author connected.
- The connection details, network checks, peer test and *Copy report* now exist (docs/network-diagnostics.md): on both
  devices open Sync > Network diagnostics and press *Test connection*; the stage and cause say what is missing.

## Verification still to do

Real-device, relay, desktop and router-matrix checks, with exact commands and pass criteria: docs/remaining-verification.md.

## Secrets check (done 2026-10-11)

Nothing private is in the public repository or its history:
- the only tracked env files are templates (`.env.example`) and local-stack defaults (`docker/.env.stack`);
- `.env.setup`, `.env` and `.vercel/` are git-ignored;
- no token or private-key patterns appear in any commit;
- the CI *secrets* job (gitleaks) passes on every push.

Real values live only in Vercel environment variables, GitHub secrets and the local `.env.setup`.
