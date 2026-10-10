# Tasks

## 1. Editor selection

- [x] 1.1 Replace `highlightActiveLine()` in `Editor.svelte` with an active-line extension that marks the cursor's line (and its gutter) only when every selection range is empty (D1).
  - Verify: a Playwright test selects three lines with Shift+Down in both themes, then asserts that no line has `cm-activeLine` and that `.cm-selectionBackground` boxes reach the last selected line.
  - Verify: with an empty selection the current line is still tinted.

## 2. Folder commands (desktop)

- [x] 2.1 `mirror_default_folder(slug)` (D3):
  - creates `<Documents>/HiveTeX/<slug>`, reusing it only when empty or marked as this project, and otherwise using `-2`…`-99`;
  - sanitises the slug and registers the folder as picked;
  - under `test-picker`, uses the test pick directory as Documents.
  - Verify: Rust tests cover a fresh folder, an empty folder, its own marker, a foreign marker, foreign files and a hostile slug (`../x`, `a/b`), and that the path is registered as picked.
- [x] 2.2 `mirror_open(id)` opens the bound root, and `mirror_reveal(id, rel?)` shows a file, with `rel` checked by `resolve_inside`. Both are suppressed under `test-picker`.
  - Verify: Rust tests show that an unbound id and a `../` path are refused.
- [x] 2.3 `mirror_open_terminal(id)` (D4) picks the platform terminal from a pure function of the executables available, starts it with the bound root as its working directory, and falls back to opening the folder with a message.
  - Verify: Rust tests of the selection function for Windows (with and without `wt`), macOS and Linux (each candidate, and none).
  - Verify: run it by hand once on Windows.
- [x] 2.4 Register the commands and keep capabilities minimal.
  - Verify: `cargo test --lib`, `cargo clippy --lib --tests`, and the config tests (CSP, permissions) still pass.

## 3. Files context menu (web app)

- [x] 3.1 Move `Menu.svelte`'s list, keyboard handling and focus return into `MenuList.svelte`, and add `ContextMenu.svelte`, positioned at the pointer or the focused row and kept inside the window (D2).
  - Verify: existing menu e2e tests (more menu, compile options) still pass, and svelte-check passes.
- [x] 3.2 Add the context menu to `FileTree.svelte` (right-click on rows and on the empty area; Shift+F10 and the ContextMenu key on a focused row), with items per role and per kind as in D2, calling the existing handlers.
  - Verify: Playwright tests: an editor right-clicks a `.tex` file and renames it through the menu; Shift+F10 opens the menu with the first item focused, and Escape returns focus to the row; a viewer sees no Rename, Delete or New file.
- [x] 3.3 Session folder actions: `openFolder()`, `openTerminal()` and `copyFolderPath()` create and bind the default folder first when the project is kept in the app (`mirror_default_folder`, then `bindFolder`), then call the command or write the clipboard. Show *Use a folder…* in their place on the web.
  - Verify: unit tests of the "bind first when needed" sequencing with a stubbed invoke; svelte-check.
- [x] 3.4 Status and errors: a toast while the folder is created ("Putting the project in Documents/HiveTeX/…"), the location button showing the new folder, and clear messages when the terminal or folder cannot open.
  - Verify: covered by the desktop test in 4.1, and a Playwright test of the web variant.

## 4. Desktop end to end and docs

- [x] 4.1 Desktop UI test: in a project kept in the app, right-click the Files panel → Open folder. Then:
  - the project is bound to `<pick dir>/HiveTeX/<slug>`, its files are on disk, and the location button names the folder;
  - a file created on disk (`sections/related.tex`) appears in the tree, and an edit to `main.tex` on disk appears in the editor, within a few seconds;
  - *Copy folder path* puts that path on the clipboard.
  - Verify: `make desktop-e2e`, in a wide window and with `HIVETEX_WINDOW=1024x768`.
- [x] 4.2 Docs and screenshots:
  - docs/folders.md: the context menu, the default folder, terminals per platform, and the note about synced Documents folders;
  - docs/interface.md: the menu and its shortcuts;
  - README: a "Use Claude Code on a project" step;
  - regenerate the screenshots if the Files panel changed.
  - Verify: links resolve.
- [x] 4.3 Full verification: `make check`; `cargo test --lib`; `make desktop-e2e` (wide and narrow); `openspec validate open-folder-from-files`; push, and CI and Desktop are green.

## Workflow follow-up

- Archive `open-folder-from-files`, commit with the attribution lines, and push (Vercel deploys from `master`).
- Release 0.2.0:
  1. `make version VERSION=0.2.0` and commit.
  2. `make release VERSION=0.2.0 CONFIRM=1`.
  3. Wait for the draft and check its Windows, macOS and Linux installers and the updater manifest.
  4. Publish after confirming with the user.
  5. Ask whether to delete the old v0.1.x draft releases.
