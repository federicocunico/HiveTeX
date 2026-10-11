# To do (owner)

## Release clean-up (optional)

- Delete the old tags `v0.1.0` and `v0.1.1` (their releases are already gone):
  `git push origin :refs/tags/v0.1.0 :refs/tags/v0.1.1 && git tag -d v0.1.0 v0.1.1`

## Peer-to-peer (user report, project `df72heljrgs56wmo`)

- Ask the user to update both devices to v0.2.1 and, if a device stays on *connecting*, to send what the Sync panel
  shows. Without a relay (no TURN by choice), two networks that cannot reach each other directly cannot sync.
- Decide whether to add the "Connection details" view (per co-author: network routes found, attempts, failure reason,
  *Copy report*).

## Secrets check (done 2026-10-11)

Nothing private is in the public repository or its history:
- the only tracked env files are templates (`.env.example`) and local-stack defaults (`docker/.env.stack`);
- `.env.setup`, `.env` and `.vercel/` are git-ignored;
- no token or private-key patterns appear in any commit;
- the CI *secrets* job (gitleaks) passes on every push.

Real values live only in Vercel environment variables, GitHub secrets and the local `.env.setup`.
