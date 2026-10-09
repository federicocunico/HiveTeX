# GitHub backup

Owners can link a project to a GitHub repository. The project is committed there automatically; this is **in addition** to
the peer-to-peer sync (and a way to start when nobody is online).

## One-time setup (operator)

Register a **GitHub App** (not an OAuth App) at <https://github.com/settings/apps/new>:

| Field | Value |
|---|---|
| Callback URL | `https://<your-deployment>/api/github/callback` |
| Request user authorization (OAuth) during installation | ✔ |
| Expire user authorization tokens | ✔ (8 h tokens + refresh tokens) |
| Webhook | off |
| Repository permissions | **Contents: Read & write**, **Metadata: Read-only**; add **Administration: Read & write** only if you want the app to create repositories (GitHub may not allow repository creation with App user tokens — if it fails, create the repository on github.com and choose "existing repository") |
| Where can this app be installed? | Any account |

Then set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` in the Vercel project. Each user installs the app on their
account/organization and selects the repositories it may access — the app can never touch anything else.

## Using it

*Project settings → GitHub backup*:

1. **Connect GitHub** – opens GitHub in your browser. The server exchanges the code (it holds the client secret) but hands the
   tokens to your device *encrypted to your device key* via a one-time, two-minute hand-off; only your GitHub login is stored.
   Tokens live in the OS credential store (desktop) or session storage (browser).
2. **Link a repository** (owners) – create a new private repository or pick an existing one, plus a branch.
3. **When to back up** (owners): after N minutes idle (default 15), after N changes, at most every M minutes (default 5),
   optionally including the compiled PDF. **Back up now** works from any device that has GitHub access.

## How a backup works

* **One writer at a time**: among online owners/editors who hold a valid token, owners go first, then the lowest device id.
  Counters and settings live in the shared project, so a takeover is seamless. If the writer's token expires, another device steps in.
* Commits go **directly from the device to `api.github.com`** with the Git Data API: only blobs that differ from the remote
  tree are uploaded; deletions of files p2platex previously committed are mirrored; foreign files are left alone.
* The commit message lists the contributing usernames and the time range.
* **Never a force-push.** If the bound branch received commits that p2platex did not make, or moved during a push, the
  snapshot is committed to `p2platex/backup` instead and owners see a notice.
* `.p2platex.json` in the repo lists the paths managed by p2platex.

## Starting from GitHub

If a member opens a project while no collaborator is online and the local copy is empty, the workspace offers **Load the latest
backup from GitHub** (needs editor access and access to the repository). The imported copy merges with your collaborators'
when they come online; identical duplicates are removed automatically.

## Verifying a fresh App

`apps/web` e2e tests (`e2e/github.spec.ts`) run the whole flow against an in-process fake of the GitHub API. To check a real App:
connect, link a scratch repository, press **Back up now**, and confirm the commit and the `.p2platex.json` file appear.
