# Proposal

## Why

Using an AI assistant (Claude Code, Codex, Cursor) on a HiveTeX project takes too many steps today. The member has to
know that *Use a folder…* hides in the location menu at the bottom of the Files panel, pick a folder, then find that
folder in a terminal. The folder sync itself already works in real time, both ways and with co-authors. What's missing
is a direct way in: right-click the Files panel and open the project's folder or a terminal in it, ready for `claude`.

Separately, the editor shows a mouse or Shift selection without its last line highlighted (Ctrl+A looks right). That
makes it hard to see what will be copied, deleted or formatted. The release that follows this change should not ship
with it.

## What Changes

- **Right-click menu in the Files panel** (desktop):
  - On the panel's empty area: **Open folder**, **Open in terminal** and **Copy folder path**, plus the existing
    *New file*, *New folder* and *Upload*.
  - On a file: the same folder actions, plus **Open**, **Rename or move**, **Delete**, **Set as main document** (`.tex`
    only), **Download** and **Show in file manager**. On a folder: **New file here**, **Upload here**, **Rename or
    move**, **Delete** and **Show in file manager**.
  - It opens with the right mouse button, the context-menu key or Shift+F10, and works with the keyboard like the app's
    other menus.
  - Viewers get only the read-only items: open, download, the folder actions, and show in file manager.
- **A folder, created on first use:** *Open folder*, *Open in terminal* and *Copy folder path* on a project still
  stored "In the app" create the folder `<Documents>/HiveTeX/<project ID>`, link it, write the project's files there,
  then do what was asked. If that folder already belongs to another project, a free name (`<project ID>-2`, …) is used.
  The status bar and the location button then show the folder as for any linked one.
- **Real-time sync is unchanged and covered by a desktop UI test:** while the folder is open, edits, new files,
  deletes and renames made on disk by any program show up in the app at once and reach co-authors as the member's
  edits. Edits made in the app or by co-authors are written to the folder.
- **Web app:** browsers can't open a file manager or a terminal, so the menu shows the file actions plus *Use a
  folder…* (the existing File System Access linking, where supported).
- **Editor selection fix:** the selected range is highlighted on every line, including the line holding the cursor.
  The current-line highlight is shown only when nothing is selected.
- **Release:** after this change, the version is set to 0.2.0 and the desktop installers are built and published.
  These are the first installers under the HiveTeX name with the compiler work.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `latex-workspace`:
  - *LaTeX editor*: the selection is visible on every selected line.
  - *File tree operations*: a context menu with file and folder actions.
  - *Local folder mirror (desktop)*: besides folders picked in a native dialog, the app may use a folder it creates
    itself under the HiveTeX projects folder on the member's request. Folders whose path comes from page content are
    still refused.
- `project-locations`:
  - *Choose where a project lives*: Open folder / Open in terminal on a project not yet in a folder creates and links
    `<Documents>/HiveTeX/<project ID>`.

## Impact

- **Desktop (Rust):**
  - New commands: `mirror_default_folder(id, slug)`, which creates and registers the folder (Rust chooses the path,
    so the "path supplied by script" protection still holds); `mirror_open(id)`, which opens the folder itself and not
    its parent; `mirror_open_terminal(id)`, which starts the platform terminal in the folder.
  - `mirror_reveal` gains an optional relative path, to show a file.
- **Web:** `FileTree.svelte` gets the context menu (reusing the Menu component and the existing actions), and
  `Workspace.svelte` / `session.svelte.ts` get the folder actions. The editor theme (`styles/editor-theme.ts`) changes
  and `Editor.svelte` gets an active-line extension.
- **Tests:**
  - Web (Playwright): the selection highlight, and the context menu with the keyboard and as a viewer.
  - Desktop (WebDriver): right-click → Open folder creates and links the folder; a file created and edited on disk
    appears in the tree and the editor.
  - Rust: default folder naming and collision handling, terminal command selection.
- **Release:** version bump to 0.2.0, tag, CI installers, publish.
- **No server changes and no new dependencies.**
