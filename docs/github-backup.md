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

The **GitHub backup** panel (the cloud icon in the workspace rail):

1. **Connect GitHub**: opens GitHub in your browser. After you authorize, GitHub returns to the HiveTeX web app
   (`#/github-continue`). The app completes the link **with the account you are signed in with there**; if needed, it asks
   you to sign in first and then continues. The server exchanges the code only if that account is the one that started the
   link, and hands the tokens to the starting device *encrypted to its device key* via a one-time, two-minute hand-off.
   Only your GitHub login is stored. Tokens live in the OS credential store (desktop) or session storage (browser).
   * **Desktop users**: GitHub opens in your system browser. Be signed in to the same HiveTeX account there (the page
     asks if you are not).
   * **Security**: a forwarded "Connect GitHub" link cannot link someone else's GitHub account to yours. Completion fails
     with "started by another account" and nothing is exchanged.
2. **Link a repository** (owners): create a new private repository or pick an existing one, plus a branch. The choice is
   recorded on the server (owners only). Devices push **only** to that repository: if the copy in the shared project data
   points elsewhere (for example, written by a modified editor client), backups stop and the panel says the target was not
   set by an owner.
3. **When to back up** (owners): after N minutes idle (default 15), after N changes, at most every M minutes (default 5),
   optionally including the compiled PDF. **Back up now** works from any device that has GitHub access.

## How a backup works

* **One writer at a time**: among online owners/editors who hold a valid token, owners go first, then the lowest device id.
  Counters and settings live in the shared project, so a takeover is seamless. If the writer's token expires, another device steps in.
* Commits go **directly from the device to `api.github.com`** with the Git Data API: only blobs that differ from the remote
  tree are uploaded; deletions of files HiveTeX previously committed are mirrored; foreign files are left alone.
* The commit message lists the contributing usernames and the time range.
* **A backup always has the whole project.** It first captures every text file and image (waiting up to 15 s for content that
  co-authors still have to send, or fetching images from them). If a file the project still lists cannot be obtained, the backup
  **fails before anything is sent**: GitHub, including the image from the earlier backup, stays as it was, the panel shows
  *Backup not started: these files are not available on this device yet (...)*, the *last backup* time does not move and all
  pending edits stay pending. A file missing on this device is never read as deleted. Only a file someone deleted in the project is removed
  from the repository (and from `.hivetex.json`), by the first complete backup after that.
* **Edits during a backup are not lost.** A backup acknowledges only the edits its capture included. What was typed while it was
  collecting images or uploading (and who typed it) stays pending, so the next scheduled backup includes it without further
  typing. If the upload fails, every pending edit and the previous *last backup* time are kept. Only one backup runs at a time on a
  device; *Back up now* during a running backup does nothing and the next scheduled one picks up what changed.
* **Never a force-push.** If the bound branch received commits that HiveTeX did not make, or moved during a push, the
  snapshot is committed to `hivetex/backup` instead and owners see a notice.
* `.hivetex.json` in the repo lists the paths managed by HiveTeX.

## Starting from GitHub

If a member opens a project while no collaborator is online and the local copy is empty, the workspace offers **Load the latest
backup from GitHub** (needs editor access and access to the repository). The imported copy merges with your collaborators'
when they come online; identical duplicates are removed automatically.

## Verifying a fresh App

`apps/web` e2e tests (`e2e/github.spec.ts`) run the whole flow against an in-process fake of the GitHub API. To check a real App:
connect, link a scratch repository, press **Back up now**, and confirm the commit and the `.hivetex.json` file appear.
