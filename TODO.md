# To do (owner)

## Deploys after CI: Vercel token (blocking)

The *Deploy* workflow deploys `master` to Vercel after CI passes, retrying failed uploads (the change is ready
locally, not pushed). It needs a long-lived Vercel token: the Vercel CLI login token on this PC
(`%APPDATA%\com.vercel.cli\Data\auth.json`) expires within hours and cannot create tokens, so it is unusable in CI.

1. Create a token at https://vercel.com/account/tokens
   - Name: `hivetex-github-deploy`
   - Scope: the team that owns the `hivetex` project
   - Expiration: *No expiration* (or a date you will remember: deploys stop when it expires)
2. Store it in GitHub (this also replaces the **empty** `VERCEL_TOKEN` secret created by mistake):
   ```bash
   gh secret set VERCEL_TOKEN        # paste the token when asked; it is not echoed
   ```
   Alternative: put `VERCEL_TOKEN=<token>` in `.env.setup` (git-ignored) and run `make setup`.
3. Tell Claude it is done: the pending change gets pushed (Deploy workflow, Vercel Git deploys off in `vercel.json`,
   docs), then the first automatic deploy is watched end to end.

Already set: the GitHub variables `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`.

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
