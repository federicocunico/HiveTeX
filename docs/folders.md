# Projects in folders

A project can live **in the app** (stored on the device, the default) or **in a folder of your choice**: a plain directory
on your disk, such as a git clone, a Dropbox folder or `~/papers/thesis`. A folder project is still shared and synced in real time
with every collaborator. The folder is just where *your* device keeps the files, so any program can open and edit them:
Claude Code, Codex, Cursor, VS Code, `sed`, a shell script.

Where a project lives is **per device**: you can keep the thesis in `D:\thesis` on your desktop and in the app on your laptop.
Folder paths and handles never leave the device; the server only knows that you are a member.

| | Desktop app (Windows, macOS, Linux) | Web app |
|---|---|---|
| Open a folder / create a project from a folder | yes | Chrome, Edge and other Chromium browsers (File System Access API) |
| Change detection | instant (OS file watcher) | instant where the browser has `FileSystemObserver`, otherwise every 1.5 s |
| After a restart | the folder is bound again automatically | the browser asks once: click **Allow access to "…"** at the bottom of the Files panel |
| Firefox, Safari | — | not available; projects live in the app (you can still import a folder or a .zip) |

## Choose where a new project lives

**New project** → *Where to keep the files on this device* → **In a folder…** → pick an empty folder (or one with sources:
they become the project's files). Then **Create project**.

## Open a folder

**Your projects** → **Open folder…** and pick a directory:

- **A folder of LaTeX sources (e.g. a `git clone`)**: you get *New project from "…"* with an ID suggested from the folder
  name. Create it and the project gets exactly that tree. The main document (`% !TEX root`, `main.tex`, or the file with
  `\documentclass` + `\begin{document}`) and the engine (`% !TEX program`, or XeLaTeX for `fontspec`/`unicode-math`) are
  detected automatically; change them later in *Project settings*.
- **A folder that already belongs to one of your projects**: it opens that project and uses the folder on this device.
- **A collaborator's project folder you have not joined yet** (e.g. a clone of the project's GitHub backup): the *Join*
  form is prefilled with its ID. Enter the project password and the folder is used for it.

What gets imported follows the mirror rules: `.git/`, `.claude/`, `.cursor/`, `.vscode/`, `node_modules/`, LaTeX build
files and `.hivetexignore` patterns stay out. Files larger than 50 MB are skipped with a notice.

## Right-click in the Files panel: open the folder or a terminal

Right-click a file, a folder or the empty part of the **Files** panel (or press Shift+F10 or the context-menu key on a
focused file). Besides the file actions (open, rename or move, delete, set as main document, download, new file,
upload), the desktop app offers:

- **Open folder:** opens the project's folder in the file manager.
- **Open in terminal:** opens a terminal in the folder, ready for `claude`, `codex` or any tool. It uses Windows
  Terminal (or a Command Prompt window) on Windows, Terminal on macOS, and on Linux the first of
  `x-terminal-emulator`, GNOME Terminal, Konsole, Xfce Terminal, kitty, Alacritty or xterm. Without any of them, the
  folder opens instead.
- **Copy folder path:** for pasting into a tool or a terminal you already have open.
- **Show in file manager:** shows the file you right-clicked, selected.

A project still kept **in the app** gets its own folder the first time you use one of these:
`Documents/HiveTeX/<project ID>` (on Linux, your XDG Documents folder). The project's files are written there and the
project uses that folder from then on, exactly as if you had chosen it with *Use a folder…*. If that folder already
exists and holds something else, `<project ID>-2` (then `-3`...) is used, and the existing folder is never touched.

From then on, everything a tool does in the folder shows up in HiveTeX at once and reaches your co-authors: edits, new
files, deletes and renames. Their edits are written to the folder within a second.

> If Documents is synced by OneDrive, iCloud Drive or similar, the project folder is synced by that service too,
> including LaTeX build files a tool may leave there (HiveTeX itself ignores them). Use *Use another folder…* to keep
> the project elsewhere.

In the web app, browsers cannot open a file manager or a terminal: the menu offers **Use a folder…** instead (Chrome,
Edge and other Chromium browsers).

## The Location menu

In a project, the button at the bottom of the **Files** panel (**In the folder …** or **In the app**) shows where the
files are on this device:

- **Use a folder… / Use another folder…** moves the project's files into a folder (they are written there right away).
- **Show in file manager** (desktop) opens the folder.
- **Stop using the folder** keeps the project in the app. The files in the folder stay where they are, but later
  edits are no longer synced through it.

The projects page shows a folder badge next to projects that use a folder on this device.

## The `.hivetex.json` marker

A folder used by a project contains a small `.hivetex.json`:

```json
{
  "version": 2,
  "project": { "id": "…", "slug": "my-paper-2026" }
}
```

This is how **Open folder…** recognizes a project folder. The GitHub backup writes the same marker (plus the list of
files it manages), so cloning the backup repository and opening the clone takes you to the project. The marker is
bookkeeping: it is never a project file and never synced as one. You can commit it.

## Edits made while the app was closed

When the app binds the folder again, it compares three versions of every file: the last version it synced (kept on
the device), the version in the folder, and the project's current version (which may have changed through
collaborators).

- Only the folder changed → the folder's version is taken (edits made with Claude Code overnight show up).
- Only the project changed → the folder is updated.
- Both changed → the changes are merged line by line from the last synced version, so edits in different places both
  survive. Where the folder and a collaborator changed the same lines, nothing is overwritten: the project keeps the
  collaborator's text, the folder's version is kept as a conflict (the same **Resolve** bar as for offline edits, also
  after a restart), and you decide which text wins. The folder file is updated to the project's text, so a copy of the
  folder's version is only in the conflict until you resolve it.
- The first time a folder is bound there is no synced version yet: a file that differs takes the folder's text (you
  chose that folder). A file that already matches the project becomes the synced version right away, so edits that
  a collaborator and a tool then make at the same time merge instead of one replacing the other.

### While files are still arriving

A file whose text has not reached this device yet is never treated as empty. The folder's copy stays exactly as it is
(it is not overwritten and not merged into the project) until the text is complete; then it is reconciled as above and
written. A file that is only named in the project but never arrives is simply left alone in the folder.

### Read-only members

A viewer's folder never changes the project, not even when it is bound or reopened. Files that differ from the project are
restored from it, with a notice ("… differs from the project and is restored from it (read-only for you)"). Files that
are not part of the project when the folder is bound or reopened are left where they are with a notice and are not shared:
the project's file list may not have fully arrived yet, and deleting them could empty the folder by mistake. After that,
changes made in the folder are reverted: edited files are restored, and new files are removed ("… is read-only for you;
your local change was reverted").

### When a file cannot be written

If a file cannot be written to the folder (disk full, locked by another program), the notice says so and the write is
tried again with a growing delay. The project's text is never marked as written before it is on disk, and a file that
was renamed or deleted while it was being written does not reappear under its old name.

## Changes view: see and undo what the tools did

There are no locks and no staging step: edits from the folder sync to everyone right away, like typing in the editor.
To keep that safe, every device keeps a **history of change sets**: **Changes** in the left rail of the workspace.

- Each change set groups the edits from one source over a few seconds: the **folder on this device** (an AI tool or
  editor), **you** in this app, a **co-author**, or an **undo**. An icon and its tooltip say which.
- Expand one to see the files and a line diff.
- **Undo** (editors and owners) reverts exactly that change set for everyone, as a new change. If later edits touched
  the same lines, the undo applies what it can and says it was partial.
- History is kept on the device for 7 days (at least the last 500 change sets) and is never uploaded.

Typical AI workflow:

```bash
cd ~/papers/thesis      # the project's folder
claude                  # or: codex, cursor .
```

Let the tool edit, watch the files update live in the app and on your co-authors' screens, review in **Changes**, and
undo any change set you don't want.

## Desktop UI tests

`make desktop-e2e` builds a debug app with the `test-picker` cargo feature (the folder dialog returns a test directory
instead of opening, because WebDriver cannot drive OS dialogs), starts the local API, and drives the real app through
[`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/): create a project from a folder, external edits, link a
folder, import a folder, open a marker folder. Requirements: `cargo install tauri-driver --locked`, plus
`WebKitWebDriver` on Linux (`webkit2gtk-driver`). On Windows, `msedgedriver` must match the installed WebView2 version
exactly: the first run downloads that version from Microsoft into `apps/desktop/src-tauri/target/msedgedriver/` and
reuses it afterwards (a new one is fetched when WebView2 updates). Offline, or to use your own copy, set
`MSEDGEDRIVER=C:\path\msedgedriver.exe`. These are developer test tools: the app itself never needs them, and release
builds never include `test-picker`.
