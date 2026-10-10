# Design

## Context

Motivation is in proposal.md. What the code does today:

- **Folder sync already works in real time.** The desktop binds a folder with `mirror_bind`, and a `notify` watcher
  emits `mirror://<id>` events. `FolderMirror` (packages/sync) turns disk changes (edits, new files, deletes, renames)
  into CRDT edits that reach co-authors, and writes remote edits back within a second. Tests in
  `packages/sync/test/mirror*.test.ts` and desktop UI test 1 cover it. No new sync mechanism is needed.
- **Folders must be picked by the user.** `mirror_bind` accepts only folders recorded in `PickedFolders`, which only
  `mirror_pick` (the native dialog) adds to. `mirror_reveal(id)` shows a bound folder in its parent through
  `tauri-plugin-opener`'s `reveal_item_in_dir`.
- **The Files panel** (`FileTree.svelte`) has per-item hover buttons and a toolbar; it has no context menu.
  `ui/Menu.svelte` is a WAI-ARIA menu button anchored to its trigger.
- **The selection bug:**
  - `drawSelection()` paints selections in a layer behind the line elements.
  - `highlightActiveLine()` gives the cursor's line an opaque `--active-line` background, which covers that layer on
    the cursor's line.
  - A mouse or Shift selection ends on that line, so its last line looks unselected. After Ctrl+A the cursor sits on
    the empty line after the text, so every text line shows.

## Goals / Non-Goals

**Goals:**
- One right-click away from a folder and a terminal ready for an AI tool, keeping the existing "only user-chosen
  folders" guarantee.
- A single context menu implementation shared by files, folders and the panel, accessible like the app's other menus.

**Non-Goals:**
- Launching a specific AI tool. The terminal opens in the folder; the member types `claude`, `codex` or anything else.
- Choosing the terminal application (the system default is used; see D4).
- Changes to how the folder sync works or how fast it is.

## Decisions

### D1. Selection fix: no active-line background while a selection exists

`Editor.svelte` replaces `highlightActiveLine()` with a small `ViewPlugin` that adds `cm-activeLine` decorations only
when every selection range is empty. The gutter gets the same treatment. The theme keeps `--active-line` for the empty
case.

*Alternatives:*
- **A translucent active-line color:** the selection would show through, but tinted differently on the last line, and
  the dark theme would need its own tuning.
- **Raising the selection layer above the text:** that would hide text and cursors.

The chosen fix shows exactly what is selected and needs no color changes.

### D2. A context menu built from the existing menu

The item list, keyboard handling and focus return move out of `Menu.svelte` into a `MenuList` component.
`Menu.svelte` (button-anchored) and a new `ContextMenu.svelte` (positioned at the pointer, or at the focused row for
the keyboard) both use it.

- **Opening it:** `FileTree.svelte` handles `contextmenu` on rows and on the empty panel area, plus Shift+F10 and the
  ContextMenu key on a focused row. The browser's own menu is suppressed only inside the Files panel.
- **What it offers:**
  - On a file: Open, Rename or move, Delete, Set as main document (`.tex`), Download.
  - On a folder: New file here, Upload here, Rename or move, Delete.
  - On the empty area: New file, New folder, Upload.
  - Then a separator and, on the desktop: Open folder, Open in terminal, Copy folder path, Show in file manager (per
    item).
  - On the web: *Use a folder…*, where File System Access exists.
  - Viewers: Open, Download and the folder actions only.
- **Reuse:** the existing hover buttons stay; menu items call the same handlers.

### D3. A folder created by the app, chosen on the native side

New command `mirror_default_folder(slug)`:

- **Path:** Rust computes `<document_dir>/HiveTeX/<slug>`, where `document_dir` is Tauri's path resolver: Documents
  on Windows and macOS, XDG Documents on Linux, with the home directory as a fallback. The slug is restricted to
  `[a-z0-9-]` (project IDs already are).
- **If the folder exists:** it is reused only if it is empty, or if its `.hivetex.json` marker names this project.
  Otherwise Rust tries `-2`, `-3`, … up to `-99`.
- **Result:** Rust creates the folder, adds it to `PickedFolders` and returns the path. The webview then calls the
  existing `bindFolder({ desktopPath })`, which writes the files and the marker exactly as for a picked folder.

Page script still cannot name an arbitrary path. The only path it can obtain this way is one Rust built under the
HiveTeX projects folder. That keeps the "Path supplied by script" scenario true.

*Alternatives:*
- **Asking with the picker:** rejected by the member's choice; it's one step too many.
- **A folder in app data:** hidden from users and awkward for terminals and AI tools.

### D4. Opening the folder and a terminal

- **Open folder:** `mirror_open(id)` opens the bound root itself (`opener.open_path`), so the file manager shows the
  folder's contents. `mirror_reveal(id, rel?)` keeps selecting the folder, or the given file, in its parent, for
  *Show in file manager*. `rel` is checked with the mirror's `resolve_inside`.
- **Open in terminal:** `mirror_open_terminal(id)` starts a terminal in the bound root, never a path from the page. It
  passes the directory as the working directory, not inside a shell string. Per platform:
  - **Windows:** `wt.exe -d <dir>` (Windows Terminal) when found on PATH, else `cmd.exe /K` with `current_dir(dir)`
    in a new console window.
  - **macOS:** `open -a Terminal <dir>`.
  - **Linux:** the first available of `x-terminal-emulator` (Debian alternatives), `gnome-terminal --working-directory`,
    `konsole --workdir`, `xfce4-terminal --working-directory`, `kitty --directory`, `alacritty --working-directory`
    and `xterm`. Each is started with `current_dir(dir)`. If none exists, the error says so and the folder opens
    instead.
- **Copy folder path:** the webview gets the bound path from the session (`mirrorDir`) and writes it with
  `navigator.clipboard.writeText`. Clipboard writes are allowed in a user gesture, so nothing native is needed.

*Alternative:* letting the member configure the terminal command. Deferred: it would be an arbitrary command run on
the member's behalf, which needs its own UI and a review.

### D5. Tests

- **Rust:** default-folder naming (fresh, empty, own marker, foreign marker, foreign files, slug sanitising), and the
  choice of terminal command per platform as a pure function of "which executables exist". No terminal is started in
  tests.
- **Web (Playwright):**
  - Selection: after Shift+Down over 3 lines, no line carries `cm-activeLine`, and the selection layer covers the last
    line.
  - The context menu with the mouse and with Shift+F10, as an editor and as a viewer (no Rename or Delete).
- **Desktop (WebDriver):** right-click the Files panel → Open folder on a project kept in the app. The project is
  bound to `<test pick directory>/HiveTeX/<slug>`. Under the `test-picker` feature, which is never in release
  builds, the test pick directory stands in for Documents and opening folders or terminals is suppressed. Then a file is created and another edited on
  disk; both appear in the tree and the editor within a few seconds.

## Risks / Trade-offs

- **[Risk] A terminal spawned with inherited environment variables.** The app runs no special environment, and the
  terminal is the member's own. It is started only from a member's click, never from page timing or remote input.
- **[Risk] A missing or unusual Linux terminal.** The fallback list covers the common desktops; otherwise a clear
  message is shown and the folder opens instead.
- **[Risk] Documents is synced (OneDrive, iCloud).** Files may also go through that service. Placing projects in
  Documents is what members expect, and *Use another folder…* is still available. `.hivetexignore` and the existing
  build-artifact filter keep aux files out of the project, but not out of the sync service; docs/folders.md says so.
- **[Trade-off] Hiding the active line while selecting.** Members lose the current-line tint during a selection, which
  is standard in other editors (VS Code dims it the same way).

## Migration Plan

No data migration. Projects already in folders are untouched. A project gets a folder only when its member asks for
one. Rollback is reverting the change: created folders stay where they are as ordinary linked folders.

**Release (after the change):**
1. `make version VERSION=0.2.0`, then commit.
2. `make release VERSION=0.2.0 CONFIRM=1`.
3. Check the draft's installers (Windows, macOS, Linux) and publish it with the member's confirmation.
4. Ask whether the old v0.1.x draft releases should be deleted.
