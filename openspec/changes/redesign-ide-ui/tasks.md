# Tasks

Reference: `mockup/hivetex-redesign.html` (visual target), `design.md` (decisions), `specs/` (behavior). Run
`pnpm -F @hivetex/web build && pnpm -F @hivetex/web size` and `pnpm exec playwright test` at the end of every group;
a group is done only when both pass.

## 1. Design system foundation

- [x] 1.1 Add `@lucide/svelte`, `@fontsource-variable/jetbrains-mono`, `@fontsource-variable/stix-two-text` and IBM Plex Sans (variable package if available, else `@fontsource/ibm-plex-sans` 400/500/600) to `apps/web`; verify `pnpm install` succeeds and `pnpm -F @hivetex/web build` emits the font files under `dist/assets`
- [x] 1.2 Create `src/styles/tokens.css` (light palette on `:root`, dark under `prefers-color-scheme` guarded by `:not([data-theme=light])` and under `[data-theme=dark]`, presence colors, syntax colors, radii, shadows, type tokens; no `color-mix()`) and `src/styles/base.css`; verify by a Vitest that parses `tokens.css` and asserts every token defined in a dark block is also defined on bare `:root`
- [x] 1.3 Add a contrast unit test over the token pairs that carry text (ink/muted/honey-ink on paper/surface/sunken, on-honey on honey, semantic on soft, syntax colors on surface, presence colors on surface at 3:1) for both themes; verify it passes at WCAG AA thresholds
- [x] 1.4 Build UI primitives in `src/ui/` (`Button`, `IconButton` with tooltip and required label, `Dialog` with focus trap/Escape/focus return, `Menu`, `Tooltip`, `Splitter`, `Toast`, `Pill`, `Avatar`, `AvatarStack`, `Field`, `Kbd`, `Icon`); verify with Vitest + `@testing-library/svelte` tests for Dialog focus trap and return, Splitter arrow-key steps and `aria-valuenow`, and IconButton exposing its name
- [x] 1.5 Add `lib/preferences.svelte.ts` (theme light/dark/system, editor font size 11–24, toolbar visibility, keymap) persisted per device, plus the pre-paint inline theme script in `index.html`; add the new keys to the legacy-name storage migration list; verify by unit tests for defaults/clamping and an e2e that reloads with Dark selected and asserts `data-theme="dark"` is present before `main.ts` runs
- [x] 1.6 Build the CodeMirror theme and highlight style from `var(--syn-*)`/tokens in `src/styles/editor-theme.ts` and switch `Editor.svelte` to it with font size from preferences; verify `.cm-content` uses the configured size and the existing `realtime` and `synctex` e2e specs pass

## 2. Landing page and auth screens

- [x] 2.1 Generalize the post-sign-in resume (today `PENDING_GH`) to any deep link in `App.svelte`, keeping GitHub-continue behavior; verify with an e2e that opens `#/p/<id>` signed out, signs in, and lands in the project, and that the `github` spec still passes
- [x] 2.2 Implement lazy `views/Landing.svelte` per the mockup (hero with source/PDF preview and co-author typing demo honoring reduced motion, six features, three-step how-it-works, newcomer/expert columns, footer, Create free account/Sign in/downloads/source) shown at `#/` and empty hash when signed out on web only; verify with a new `e2e/landing.spec.ts` (signed-out root shows landing, CTA opens register, signed-in root shows "Your projects", desktop mode goes to sign-in) and that `size` reports the landing chunk is not in the initial load
- [x] 2.3 Resolve download links (latest release asset per OS, fallback to releases page, detected OS listed first); verify with a unit test of the URL resolver for Windows/macOS/Linux/unknown
- [x] 2.4 Restyle `Auth.svelte` into the split layout for login/register/forgot/reset/verify, keeping `ServerChoice` on desktop, with visible labels, show-password toggle, correct `autocomplete` tokens, and live rule checks (username format, 12+ characters, repeat matches) with server errors shown at the field via `aria-describedby` and announced; verify `auth-and-collab` and `a11y` specs pass unchanged and a new e2e asserts the length rule turns met at 12 characters and a taken username shows under the Username field
- [x] 2.5 Extend `e2e/a11y.spec.ts` to the landing page (light and dark, 390 px no horizontal overflow) and auth screens in dark theme; verify zero serious/critical violations

## 3. App shell, projects and templates

- [x] 3.1 Replace the topbar in `App.svelte` with the new app header (logo, palette search box placeholder, help, avatar menu with Account/Admin/Sign out, Source link); verify "Sign out" and Admin access e2e still pass
- [x] 3.2 Redesign `Projects.svelte`: "Your projects" heading, New project (primary), Join with ID and Open folder as secondary actions, All/Owned/Shared tabs, sort, rows with thumbnail, slug, role pill, avatars, last opened, folder/backup badges and a designed empty state; keep `project-list`, `opened-ago`, `open-folder`, `from-folder*`; verify `recents`, `folders` and `full-flow` specs pass and the 390 px a11y overflow check passes
- [x] 3.3 Turn New project and Join a project into `Dialog`s that remain `<form>`s titled by `<h2>New project</h2>` / `<h2>Join a project</h2>` with the existing fields (placeholder `my-paper-2026`, password, folder option); update `e2e/helpers.ts` `createProject`/`joinProject` and `apps/desktop/e2e/desktop.test.mjs` to click the opening button first; verify all e2e specs and the desktop UI test pass
- [x] 3.4 Add bundled templates in `src/templates/` (blank, article, thesis/report, beamer, letter, CV) with `meta.json`, teaching comments, redistributable content and a pre-rendered `preview.svg`, loaded lazily via `import.meta.glob`; verify a Vitest compiles every non-blank template with the in-browser engine without errors and the native-TeX CI job compiles them too
- [x] 3.5 Add the template gallery to the New project dialog (Blank selected by default) and write the chosen template's files plus the `main` setting on create, including into a chosen folder on desktop; verify a new `e2e/templates.spec.ts` (Article creates `main.tex` + `.bib`, main file set, compiles; Blank yields an empty project) and the desktop test creating into a folder

## 4. Workspace shell

- [x] 4.1 Add `lib/layout.svelte.ts` (open panel, side width, split ratio, PDF visible, zoom, focus mode; persisted per device; reset) with unit tests for persistence and reset; verify tests pass
- [x] 4.2 Split `Workspace.svelte` into `WorkspaceHeader`, `ActivityRail`, `SidePanel`, `EditorArea`, `PdfPane` and `StatusBar` on the grid `rail | side | editor | splitter | pdf`, moving every existing testid (`workspace`, `project-slug`, `role-pill`, `settings-btn`, `compile-mode`, `leader`, `compiled-by`, `stale-badge`, `no-peer-compiler`, `peer-count`, `statusbar`, `pause-sync`, `pdf-scroll`, `location-btn`, `import-btn`, `folder-badge`, `unlink-folder`, `editor`, `file-tree`); verify every existing e2e spec and the desktop test pass
- [x] 4.3 Implement the header (back, name, slug, role, avatars, Share, Recompile split button with "Compile on this device", Download PDF, More menu holding Import, Download .zip, History, Settings, folder location); verify `compile-modes`, `import`, `folders` specs pass and a new e2e asserts the header holds at most four actions besides More
- [x] 4.4 Implement the activity rail and panels: Files (existing `FileTree` with Lucide icons instead of emoji), Search (existing search/replace), Changes (moved from dialog, with unseen count badge), History (extracted from inline markup), People, Backup (existing `GithubPanel`); verify `changes`, `github`, `realtime` specs pass, plus a new e2e for panel switching, collapse on re-click, and the unseen-changes badge clearing
- [x] 4.5 Implement Splitter-based resizing for side panel and editor/PDF, PDF collapse with a visible "Show PDF" action, the <1100 px Editor/PDF toggle (fixing the dead `show-narrow` rule) with overlaying side panel, and focus mode; verify a new e2e for keyboard resize, collapse/restore, 1024 px layout with no overflow, and focus mode restore
- [x] 4.6 Rewrite status bar and PDF toolbar copy in plain language ("All changes synced", "N people online", "Compiled on <device> (fastest online)", "Outdated: N edits since last compile", offline explanation with Work offline/Resume); update text assertions in `full-flow`, `offline-and-compile`, `compile-modes` in the same change; verify those specs pass
- [x] 4.7 Implement the Problems panel under the editor (file, line, original message, Go to line, Raw log) replacing the diagnostics list; verify the existing inline-error behavior and a new e2e that a failing compile lists the error and Go to line moves the cursor

## 5. Commands and keyboard

- [x] 5.1 Add `lib/commands.svelte.ts` registry and register every workspace, projects and app action with role guards, shortcuts and search aliases (including old names such as "Share ID", "Settings"); verify a unit test that ids are unique, shortcuts do not collide, and viewer context hides editing commands
- [x] 5.2 Implement `CommandPalette.svelte` (Ctrl/Cmd+K anywhere signed-in; fuzzy search over commands, files, outline, projects; `>`, `@`, `:` prefixes; shortcut hints; keyboard navigation) using `Dialog`; verify a new `e2e/palette.spec.ts` (run Compile via palette, open file, `:120` goes to line, viewer sees no rename) and axe on the open palette
- [x] 5.3 Wire the global keydown handler and the editor keymap to the registry (Ctrl/Cmd+Enter and Ctrl/Cmd+S compile, Ctrl/Cmd+Shift+Enter local compile, Ctrl/Cmd+Shift+E side panel, Ctrl/Cmd+Alt+P PDF, Ctrl/Cmd+Shift+F focus, Ctrl/Cmd+Shift+H search, Ctrl/Cmd+Shift+/ reference, Ctrl/Cmd+Alt+J SyncTeX), without overriding editing keys; verify e2e that Ctrl+S compiles without the save dialog, Ctrl+Enter inserts no newline, and the `synctex` spec passes
- [x] 5.4 Add the shortcut reference dialog generated from the registry; verify e2e that Ctrl+Shift+/ opens it listing every registered shortcut and Escape closes it
- [x] 5.5 Add lazy Vim/Emacs keymaps via a CodeMirror compartment and a Vim mode indicator in the status bar; verify e2e that selecting Vim enables normal mode and that with Default keymap no vim/emacs chunk is requested

## 6. Authoring aids

- [x] 6.1 Implement `FormatToolbar` (section menu, bold, italic, lists, inline/display math, symbol, figure, table, citation, reference) as CodeMirror transactions that wrap selections, with tooltips showing the inserted LaTeX, hidden for viewers and when the preference hides it, plus Ctrl/Cmd+B / Ctrl/Cmd+I in `.tex`; verify unit tests of the insertion functions and an e2e that Bold wraps a selection and syncs to a second peer
- [x] 6.2 Implement figure (pick project image → `figure` with `\includegraphics`, caption, `fig:` label) and table (rows × columns → `tabular`) helpers; verify unit tests for generated LaTeX (3×4 table, figure label from file name)
- [x] 6.3 Implement citation and reference pickers reusing the completion index; verify e2e that picking `knuth84` from a project `.bib` inserts `\cite{knuth84}`
- [x] 6.4 Implement the lazy symbol palette (`lib/symbols.ts`, ≥200 entries searchable by name and command, `$…$` wrapping outside math); verify unit tests for search and math-mode wrapping
- [x] 6.5 Implement the Outline panel (sectioning across `\input`/`\include`, current-section marker, click to jump, live updates); verify unit tests on the outline parser and an e2e that a co-author's new `\section` appears without reload and clicking jumps to it
- [x] 6.6 Implement `lib/compile-help.ts` (explanations and fix builders for missing-package commands, `Missing $ inserted`, file not found, missing `\begin{document}`, undefined citations/references, overfull boxes) and show them in the Problems panel with editor-only one-click fixes that undo normally; verify unit tests against real log excerpts (including "unknown error shows original only") and an e2e that "Add natbib" inserts the package and Undo removes it

## 7. Collaboration UI

- [x] 7.1 Extend awareness local state with the active `file` and map `colorFor(username)` onto the token presence palette; show the avatar stack in the header (tooltip with name and file), file-tree dots and editor-tab dots; verify unit test that missing `file` is tolerated and a `realtime` e2e that the second peer's avatar tooltip names the file the first peer has open
- [x] 7.2 Implement Follow (from avatar or People panel; opens the followed file, tracks cursor, stops on local typing/scroll/file change or peer leaving; followed avatar marked); verify a two-browser e2e for follow across a file switch and stop on scroll
- [x] 7.3 Extract `MembersSection` and `JoiningSection` from `ProjectSettings.svelte` and build `ShareDialog` (ID with Copy invitation without password, password, default role, members) with read-only form for editors and viewers; keep `members-table` and `Role of <user>` labels; verify `auth-and-collab` passes, plus a new e2e that the copied invitation contains the ID but not the password and a role change from Share takes effect
- [x] 7.4 Restyle `ProjectSettings`, `ImportDialog`, `ChangesPanel`, `GithubPanel`, `Account` (adding the Preferences section: theme, editor font size, toolbar, keymap, reset layout) and `Admin` with the primitives and add focus traps where missing; verify `import`, `github`, `changes` specs and axe on settings and import dialogs pass

## 8. Onboarding and desktop polish

- [x] 8.1 Implement the first-run tour (≤5 steps: editor, rail, compile, share; skippable; stored per device; replay from Help) using `Dialog` semantics; verify e2e that skip prevents reappearance in another project and Help → "Take the tour" restarts it, and that existing specs are unaffected because helpers dismiss or pre-set the tour flag
- [ ] 8.2 Set the Tauri window `minWidth` 1024 / `minHeight` 640 and refresh app icons with the hex mark; verify `pnpm -F @hivetex/desktop build` succeeds and the desktop UI test passes on Windows and Linux CI
- [x] 8.3 Remove the retired `app.css` rules and any unused styles/components, and check that no emoji remain in UI markup; verify `pnpm lint`, `svelte-check`, and a grep test for the replaced glyphs pass
- [x] 8.4 Update `README.md` screenshots and the docs pages describing the UI (workspace tour, shortcuts table generated from the registry); verify the docs build/links check and that the shortcuts table matches the registry test output

## 9. Integration checks

- [ ] 9.1 Run the full Playwright suite, the desktop UI test, `a11y` in both themes, `check-bundle.mjs`, `pnpm test` and `pnpm lint`; verify all pass and the initial JS stays within the 250 KB gzip budget
- [x] 9.2 Do a manual heuristic walkthrough against the review panels in the mockup (newcomer: sign up → template → write → fix an error → share; expert: palette-only session, Vim, resize, focus, follow) on web and desktop, light and dark, at 1024 px and 1440 px; record findings in the change folder and fix or ticket any H1–H10 regressions

## Workflow follow-up

- Archive the change with `/opsx:archive` after review, which merges the delta specs into `openspec/specs/`.
