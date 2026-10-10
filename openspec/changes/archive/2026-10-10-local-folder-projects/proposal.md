# Proposal

## Why

Today a project lives inside the app: in IndexedDB on the web and in the app data on desktop. A local folder can only
be attached afterwards, on desktop, as a "mirror". Users want to work the way they already do:

- choose **where** each project lives on their machine;
- **open a folder they already have**, for example a cloned Git repository, and get a project with exactly that
  tree;
- see their **recent projects** across devices;
- let AI tools (Claude Code, Codex, Cursor…) edit the files directly, then **see in the app what changed** and have
  it reach every co-author.

The files must stay plain files in the user's folder: no lock-in, nothing that only HiveTeX can read.

Three points were left open by the previous changes and are closed here too:
- a fast reconnect of the same device can drop its new connection (flaky `full-flow` test);
- the desktop folder picker has only a manual check;
- the CI actions run on the deprecated Node 20, and the Docker stack is never exercised in CI.

## What Changes

- **Project locations (desktop, and the web app on Chromium):**
  - When creating a project, choose to keep it in the app or **in a folder** (an empty one, or one with sources).
  - **Open folder…** on the projects page:
    - If the folder already belongs to a project (it has a `.hivetex.json` marker, for example a clone of the
      project's GitHub backup), that project opens: joined if needed, with the folder bound.
    - Otherwise the app offers **Create a project from this folder**: the tree is imported as is and the folder stays
      bound.
  - **Change location / Stop using folder** per project, plus a per-device list of where each project lives.
- **Folder marker:** the bound folder gets `.hivetex.json` with the project id and slug (no secrets, no content). It is
  the same file the GitHub backup already writes, extended with the project identity, so clones are recognised. The
  marker is never synced as a project file.
- **Web folder support (Chromium):** a File System Access implementation of the mirror's file-system interface.
  - Directory handles are remembered in IndexedDB, and permission is re-granted with one click per session.
  - Changes are detected by polling (or `FileSystemObserver` where available).
  - Firefox and Safari keep the current behaviour, with a clear explanation.
- **Changes view:** every external edit (AI tool or editor on the folder) and every co-author edit is recorded as a
  change set with:
  - **source:** this device's folder, or a co-author's name;
  - **time and files**, with a **per-file diff**;
  - **Undo**, applied as a normal collaborative edit; later edits are preserved.
  Disk edits keep syncing **automatically** (no staging, no locks); the view makes them visible and reversible.
- **Recent projects on the account:** opening a project records the time on the control plane (`last_opened_at` per
  membership, no content). The projects page sorts by it on every device and shows where the project lives on this
  device.
- **Open points from previous changes:**
  - **Same-device reconnect:** signaling sessions carry a connection id, so a stale session's cleanup can no longer
    remove the presence of the device's new session, or make peers drop it.
  - **Automated desktop UI tests:** WebDriver (`tauri-driver`) tests in CI on Linux and Windows. They cover link
    folder, open folder, create from folder and import folder, through a test-only picker override available in test
    builds only.
  - **CI hygiene:** actions bumped to Node 24 majors; a nightly or manual workflow runs `make test-stack`.

## Capabilities

### New Capabilities
- `project-locations`: where a project lives on each device, opening and creating projects from folders, the folder
  marker, and folder access in the web app.
- `change-history`: the changes view, with attributed change sets, per-file diffs and undo of external and remote edits.

### Modified Capabilities
- `latex-workspace`: the local folder mirror is no longer desktop-only (Chromium web app too) and is the storage
  location chosen by the user; the mirror ignores the folder marker.
- `project-access`: project listing shows account-wide recents.
- `peer-sync`: a quick reconnect of the same device keeps its new connection.
- `local-dev-environment`: automated desktop UI tests and a scheduled verification of the Docker stack.

## Impact

- **Web:**
  - `views/Projects.svelte`: recents, Open folder…, create in folder.
  - `views/Workspace.svelte`: location menu, Changes panel.
  - New `lib/fs-access.ts` (web `FsAdapter`), `lib/locations.ts` (per-device registry), `components/ChangesPanel.svelte`.
  - `session.svelte.ts`: binding on open, change log.
- **Sync:**
  - `mirror.ts`: marker handling, ignore list.
  - New change-log module (attribution, grouping, undo via 3-way inverse merge).
- **Desktop (Rust):** a test-picker override behind a `test-picker` cargo feature. Markers are read through the
  existing confined mirror commands.
- **Server:** migration `0002` adds `memberships.last_opened_at`; `POST /projects/:id/opened`; `GET /projects` returns
  `lastOpenedAt` sorted; signaling session ids.
- **GitHub package:** the backup writes the project identity into `.hivetex.json`.
- **CI:** `.github/workflows/*` (Node 24 actions, `desktop-e2e` job, `stack-nightly.yml`).
- **Privacy:** the control plane additionally learns *when* a member opens a project, which the user accepted. Folder
  paths never leave the device.
