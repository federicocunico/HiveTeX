# Design

## Context

See proposal.md (Why). The visual reference is `mockup/hivetex-redesign.html` in this change, a clickable board with
these screens:
- landing;
- create account;
- projects with the template gallery;
- the workspace with palette, share and tour overlays;
- the design system.

Each screen carries a usability review for a newcomer and for an experienced user.

**Current front end** (one code base for web and desktop):
- **Stack.** `apps/web` is a Svelte 5 (runes) SPA on Vite 7 with a ~20-line hash router (`src/lib/router.svelte.ts`).
  `App.svelte` switches between the `Auth`, `Projects`, `Workspace` (lazy), `Account`, `Admin` and `GithubContinue`
  views.
- **Desktop.** `apps/desktop` is Tauri 2 with no UI of its own. It loads `apps/web/dist`, and desktop-only UI sits
  behind `isDesktop` (server chooser, folder pickers, update check).
- **Styling.** One global `src/app.css` (557 lines) with about 15 CSS variables and an automatic dark mode. Icons are
  emoji, the font is the system stack, and there is no theme toggle.
- **Packages.** `packages/ui` is an empty placeholder that nothing imports.
- **Workspace screen.** `Workspace.svelte` (610 lines) has:
  - a toolbar of about 17 controls;
  - a file tree and search on the left, CodeMirror 6 with `yCollab` in the middle, and pdf.js with diagnostics on
    the right;
  - a status bar of text pills;
  - dialogs for Changes, Settings (which includes the members table), Import and an inline History.
- **Presence.** Awareness carries only `{ user: { name, color } }`. The color comes from `colorFor(username)`.
- **Tests.**
  - Playwright specs in `e2e/` select by many `data-testid`s, by roles and labels (for example "Your projects",
    "Create account", "Recompile", "New file") and by structure (for example
    `form:has(h2:text("New project"))`).
  - `e2e/a11y.spec.ts` runs axe and fails on serious or critical violations.
  - `apps/desktop/e2e/desktop.test.mjs` uses testids and XPath on the same headings, labels and forms.
- **Bundle budget.** `apps/web/check-bundle.mjs` caps the initial JS at 250 KB gzip and checks that the pdf and wasm
  chunks stay lazy.

### Heuristic review of the current UI

The ratings use Nielsen's ten heuristics (H1–H10), applied to two people: N, writing a first LaTeX paper, and E, a
LaTeX and IDE veteran.

| Finding | Heuristic | Hurts |
|---|---|---|
| 17 equal-weight toolbar buttons with no hierarchy; Recompile does not stand out | H8 aesthetic/minimal | N, E |
| Emoji icons (📄 ★ ✎ 🗑) render differently per OS and carry no names | H4 consistency | N, E |
| "leader", "compiler: none available", "compiles here only" are system words | H2 real-world match | N |
| Compile errors show raw TeX log lines only | H9 error recovery | N |
| No templates; a new project is empty | H6 recognition, H10 help | N |
| No landing page; the root address is a sign-in form with no explanation | H10 help | N |
| No command palette, outline, resizable panes or app shortcuts | H7 flexibility | E |
| Presence is the text "2 peers online: …"; there is no avatar, file location or follow | H1 visibility | N, E |
| Share copies the slug only; the members list is buried in Settings | H6 recognition | N |
| No focus trap in Settings or History; the `show-narrow` toggle has no CSS rule | A11y, H4 | N, E |
| Dark mode follows the OS only and cannot be chosen | H3 user control | E |

The specs in this change answer each row. The mockup's review panels show the intended result.

## Goals / Non-Goals

**Goals:**
- One token-driven design system that every screen uses, for web and desktop alike.
- Restructure the workspace (header, rail, panels, splitters, status bar) without changing sync, compile or access
  behavior.
- Keep e2e and desktop tests green after every task group by preserving hooks or updating tests in the same task.
- Stay within the existing initial-JS budget by lazy-loading the landing page, templates, symbol data and keymaps.

**Non-Goals:**
- Replacing Svelte, the hash router or CodeMirror.
- A visual (WYSIWYG) editing mode, comments, AI features or i18n. Strings stay in English but are no longer scattered
  through markup, which makes later i18n easier.
- Moving UI into `packages/ui` (see Decision 2).
- Native Tauri menus or a custom title bar. The window keeps native decorations.

## Decisions

### 1. Visual direction: "honey on slate"

The neutrals are cool slate grays, and the single brand accent is honey (the hive):
- honey (`--honey`) fills primary buttons and active markers;
- `--honey-ink` is the darker variant for accent text and focus rings, keeping text at 4.5:1;
- semantic colors (ok, warn, bad) are separate from the accent;
- presence colors are a fixed set derived from the account (Decision 9).

The fonts are:
- **IBM Plex Sans** for the interface;
- **JetBrains Mono** for code;
- **STIX Two Text** (a scientific-publishing serif) only for display text on the landing and auth pages, which echoes
  the typeset PDF.

The PDF desk and pages keep paper colors in both themes.

*Alternatives:* Overleaf's green-and-white look was rejected as derivative. A dark-first IDE look was rejected because
it intimidates newcomers; dark stays fully supported. System fonts only would be smaller, but give inconsistent
metrics in WebView2 and WebKitGTK, which matters for the dense IDE layout.

### 2. Tokens and components live in `apps/web`, not `packages/ui`

The design system goes into these folders:
- `apps/web/src/styles/` holds `tokens.css`, `base.css` and `editor-theme.ts`;
- `apps/web/src/ui/` holds the primitives:
  - `Button`, `IconButton` (with tooltip), `Dialog` (focus trap, Escape, focus return), `Menu`, `Tooltip`;
  - `Splitter`, `Toast`, `Pill`, `Avatar`, `AvatarStack`, `Field`, `Kbd`, `Icon`.

Components read tokens only. `app.css` is retired once the last screen has moved.

*Alternative:* building `packages/ui` as a Svelte library. It was rejected because it has one consumer, and the
Svelte package build and export conditions add tooling cost for no reuse. The placeholder package is left untouched.

### 3. Theme: `data-theme` on `<html>`, set before paint

`tokens.css` defines the light palette on `:root`. It redefines only tokens under
`@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) }` and under `:root[data-theme=dark]`.

A tiny inline script in `index.html` reads the stored preference and sets `data-theme` before the stylesheet applies,
so there is no flash. That localStorage key gets the same legacy-name migration handling as other settings.

The CodeMirror highlight style and theme are built from CSS variables (`var(--syn-*)`), so a theme switch needs no
editor reconfiguration.

Production CSS avoids `color-mix()` and other features WebKitGTK 2.38 lacks. Tints are precomputed as tokens.

### 4. Icons: Lucide for Svelte, tree-shaken

The project uses `@lucide/svelte` (Svelte 5), importing per icon. A wrapper `Icon` sets stroke and size from tokens.
All emoji glyphs in tree, toolbar and badges are replaced.

The desktop e2e test strips `★📄📁▾▸` from tree text today. Once the glyphs are gone that becomes a no-op, and the
test is simplified.

*Alternative:* a hand-made SVG sprite, as in the mockup. Rejected because Lucide already covers every glyph we need
and keeps a consistent geometry.

### 5. Fonts: self-hosted through Fontsource

Fonts come from `@fontsource-variable/ibm-plex-sans` (or the static `@fontsource/ibm-plex-sans` at weights 400, 500
and 600 if no variable build exists), `@fontsource-variable/jetbrains-mono` and `@fontsource-variable/stix-two-text`.
They are subset to Latin and Latin-ext, with `font-display: swap`.

STIX is imported only by the landing and auth chunks. No request goes to Google Fonts, which keeps desktop offline use
intact and avoids leaking visits to a third party.

### 6. Landing page is a lazy route inside the SPA

When signed out, `#/` and the empty hash render a lazy-loaded `Landing.svelte` instead of redirecting to `#/login`.
Signed-in users get `Projects`, so the landing page is never fetched for them. On desktop, `isDesktop` sends `#/` to
`#/login` as today.

Deep links (for example `#/p/<id>`) store the intended hash in sessionStorage before redirecting to login, and resume
after sign-in. This generalizes the existing `PENDING_GH` mechanism, which stays as a special case of it.

Download links resolve the latest GitHub release from the existing release-distribution metadata or the
`VITE_SOURCE_URL` repository, falling back to the releases page.

*Alternative:* a separate static `landing.html` served at `/`. Rejected because the app lives at `/` with hash routes,
the server cannot see the hash, and a split would break existing bookmarks.

### 7. Workspace shell decomposition

`Workspace.svelte` becomes a thin shell that owns session lifecycle and layout state. The pieces are:
- `WorkspaceHeader`;
- `ActivityRail`;
- `SidePanel`, which hosts `FilesPanel` (the existing `FileTree` plus search), `OutlinePanel`, `SearchPanel`,
  `ChangesPanel` (moved from a dialog to a panel), `HistoryPanel` (extracted from the inline markup), `PeoplePanel`
  and `BackupPanel` (the existing `GithubPanel`);
- `EditorArea`, with tabs, the `FormatToolbar`, `Editor` and `ProblemsPanel`;
- `PdfPane`, with `PdfToolbar` and the existing `PdfView`;
- `StatusBar`.

Layout is CSS grid: `rail | side | editor | splitter | pdf`. `Splitter` is a small in-house component with
`role=separator`, `aria-valuenow`, pointer drag and arrow-key steps. Under 1100 px a segmented Editor/PDF toggle
replaces the split, and the side panel overlays.

Layout state (sizes, open panel, PDF visibility, zoom, focus mode) lives in `lib/layout.svelte.ts`, persisted per
device in localStorage.

*Alternative:* the PaneForge library. It was rejected for about 80 lines of code we need to control for a11y anyway.

### 8. One command registry drives palette, shortcuts, menus and reference

`lib/commands.svelte.ts` defines `Command { id, title, group, keys?, when(ctx), run(ctx) }`. `ctx` exposes the role,
the session, the active file and layout.

These all read from the registry:
- the palette (`CommandPalette.svelte`, fuzzy match over commands, files, outline and projects, with `>`, `@` and
  `:` prefixes);
- a single global `keydown` handler;
- header and More menus;
- the shortcut sheet.

Editor-scoped keys (bold, italic, Ctrl+Enter, Ctrl+S) are bound as a CodeMirror keymap that dispatches registry
commands, so they work while the editor has focus and never fight CodeMirror's own bindings.

The Vim keymap (`@replit/codemirror-vim`) and the Emacs keymap (`@replit/codemirror-emacs`) are dynamically imported
through a CodeMirror `Compartment`.

### 9. Presence: account-derived color and current file

The existing `colorFor(username)` is kept: usernames are unique and immutable, so the color stays the same everywhere.
Its output is mapped onto an 8-color presence palette with token variants for light and dark that meet 3:1 against
the editor background.

The awareness local state gains `file: <path|null>`, set when the active file changes. Readers treat a missing `file`
as unknown, so older peers are compatible.

"Follow" is a client-only mode. It subscribes to the followed peer's awareness (`file` plus the cursor position from
`yCollab`'s `cursor` field) and opens or scrolls to it. Local input, scrolling or a file change ends it.

### 10. Share dialog reuses project-settings logic

The members table and the "Joining" section (default role, ID change, password) are moved out of
`ProjectSettings.svelte` into `MembersSection` and `JoiningSection`. Both `ShareDialog` and `ProjectSettings` render
them. The `members-table` testid and the `Role of <user>` labels move with them.

"Copy invitation" builds plain text: the app URL, the project ID, "ask the owner for the password", and steps. It
never includes the password.

### 11. Authoring aids are pure editor transactions

`FormatToolbar` actions and Problems quick-fixes dispatch CodeMirror transactions on the Y-bound document. They
therefore sync, appear in Changes and undo through the existing `yUndo`, with no new data path. The pickers are:
- the citation picker and reference picker, which reuse the label and bibliography index that already feeds
  completion (`lib/latex.ts`);
- the symbol palette, whose data (`lib/symbols.ts`, about 250 entries of name, command and category) is a lazy
  chunk;
- the outline, built by a debounced scan of sectioning commands across the main file and followed
  `\input`/`\include`, reusing the model's text access.

Compile-error help is a table in `lib/compile-help.ts`. Each entry has a pattern, a plain-language explanation and an
optional fix builder. Examples:
- a command-to-package map for `\citep`, `\includegraphics`, `\url`, `\mathbb`, `\toprule`, `\SI` and others;
- "Missing $ inserted";
- "File … not found";
- "Missing \begin{document}";
- undefined citations and references;
- overfull boxes.

Errors without a matching entry show the original message only. This is unit-tested with real log excerpts.

### 12. Templates are bundled files fed through project creation

`apps/web/src/templates/<id>/` holds the files of each template, plus `meta.json` with the name, description, main
file and a pre-rendered `preview.svg` of page 1. Templates are imported with Vite `import.meta.glob(..., { query:
'?raw', eager: false })`, so the gallery chunk loads only when the dialog opens.

On create, the files are written through the same path the import feature uses for creation-time content, and the
`main` setting is set to the template's main file. "Blank" writes nothing.

A Vitest suite compiles each template with the in-browser engine (`@hivetex/compile`) and asserts no errors. CI's
existing TeX job compiles them natively.

### 13. Test compatibility strategy

These hooks are kept:
- every existing `data-testid` (moved with its element);
- the headings "Your projects" and "Sign in";
- the buttons "Create account", "Create project", "Join", "Recompile", "New file", "Upload files" and "Close";
- the labels "Username", "Email", "Password" and "Repeat password".

The New project and Join flows become dialogs. Each remains a `<form>` whose title is an `<h2>` with the same text,
so `form:has(h2:text("New project"))` and the desktop XPath still match once the dialog is open.

`e2e/helpers.ts` (`createProject`, `joinProject`) gains a click on the opening button. The desktop test gets the same
change.

Wording changes such as "2 peers online" becoming "2 people online" are made together with their assertions. axe runs
are extended to the landing page, the dark theme, the Share dialog and the palette.

## Risks / Trade-offs

- [The large surface area breaks many e2e specs at once] → The work is sliced per screen (see tasks). Each slice
  updates its tests in the same task, and the full suite runs at the end of every group.
- [The initial bundle grows from fonts, icons and new components] → Icons are tree-shaken, fonts are CSS assets (not
  JS), and the landing page, templates, symbols, keymaps and palette search index are lazy. `check-bundle.mjs`
  enforces this.
- [The honey accent fails contrast on white] → Honey is used only as a fill behind dark text. Accent text and focus
  rings use `--honey-ink`. The dark-theme axe run guards this.
- [Presence colors collide for large groups] → Usernames are always shown on cursors, and the avatar tooltip names the
  person and file. Color is never the only cue.
- [Ctrl+S or Ctrl+Enter conflicts on some layouts, or with Vim] → Bindings come from the registry and are overridden
  in Vim mode where Vim needs the key. The shortcut sheet always shows the current bindings.
- [WebKitGTK (Linux desktop) lacks newer CSS] → No `color-mix()`, `:has()` in critical paths, or nesting without a
  build step. The desktop UI test runs on Linux CI.
- [Users of the old layout lose their bearings] → All actions remain, and the palette finds any of them by its old
  name too: aliases such as "Settings" and "Share ID" are kept as search terms.

## Migration Plan

- Ship as a normal release (no flag). There are no data migrations, beyond optionally adding the new theme and layout
  keys to the existing legacy-name localStorage migration list.
- Rollback means reverting the release. Older clients ignore the new awareness `file` field, and newer clients
  tolerate its absence.

## Open Questions

- Should the landing page's download buttons detect the visitor's OS to pick the primary download? The default plan
  is to detect it, and show all three with the detected one first.
- Final copy for the landing page should be reviewed by the maintainer. The mockup copy is the starting point.
