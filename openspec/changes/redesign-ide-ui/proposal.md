# Proposal

## Why

HiveTeX already works as a real-time, peer-to-peer LaTeX editor, but it does not look or feel like one. The web and
desktop (Tauri) apps share one plain Svelte front end with a 17-button toolbar, emoji icons, no landing page, a bare
registration form and no help for someone writing their first paper. People new to code find it hard to get started.
Experienced LaTeX users get no command palette, no outline, no resizable panes and no keyboard model beyond
CodeMirror's defaults. Collaboration is the product's core, yet presence is just a peer count in the status bar.

This change redesigns the whole interface as a modern LaTeX IDE built for collaborative paper writing. It takes cues
from Overleaf's familiar source + PDF split and from Oleafly's activity rail, outline, symbol palette and template
gallery. Every screen is checked against usability heuristics for two kinds of users: people new to LaTeX and code, and
experienced LaTeX and IDE users.

## What Changes

- **New visual identity and design system** shared by web and desktop:
  - design tokens for color, type, spacing, radius and elevation;
  - bundled fonts that work offline on desktop;
  - one SVG icon set that replaces the emoji glyphs;
  - light, dark and system themes the user can choose;
  - a syntax highlight theme for the editor built from the same tokens.
- **Public landing page** for signed-out web visitors. It explains the product (live co-writing, offline,
  peer-to-peer compile, privacy), shows the editor, and links to sign-up, sign-in, desktop download and source. The
  desktop app skips it and opens sign-in.
- **Redesigned auth screens** (sign in, register, forgot/reset, verify): a split layout with a product panel,
  password-strength feedback while typing, inline field validation, and a show-password toggle. The desktop server
  chooser keeps its place.
- **Redesigned project dashboard**:
  - project cards or rows with role, collaborators, last-opened time and folder or backup badges;
  - search and sort;
  - one clear "New project" button that opens a template gallery;
  - "Join with ID" and "Open folder" as secondary actions;
  - a designed empty state for first-time users.
- **Project templates**: create a project from a bundled template (blank, article, report or thesis, Beamer
  slides, letter, CV), with previews.
- **IDE workspace layout**:
  - a slim header with the project name, collaborator avatars, Share and Compile;
  - an activity rail that switches the side panel between Files, Outline, Search, Changes, History,
    Collaborators and Backup;
  - resizable, collapsible editor and PDF panes whose sizes are remembered;
  - a focus mode;
  - a status bar with sync, compile and peer status in plain language.
- **Command palette and keyboard model**:
  - every workspace action is reachable from a searchable palette (Ctrl/Cmd+K) with its shortcut shown;
  - a shortcut reference sheet;
  - optional Vim or Emacs keybindings in the editor.
- **Authoring aids for newcomers**:
  - a formatting toolbar (sections, bold/italic, lists, math, figure, table, citation, reference);
  - a searchable symbol palette;
  - a document outline with click-to-jump;
  - plain-language explanations for common compile errors, linked to the source line;
  - a short, dismissible first-run tour.
- **Share dialog**: one place to copy the project ID or invite text, set or clear the password, choose the default
  role and manage members. It replaces "Share ID" (copy-only) plus the members table hidden in Settings. Owners still
  manage the same permissions.
- **Richer presence**: an avatar stack in the header with a stable color per collaborator, the file each one is in,
  remote cursors and selections in matching colors, and "follow" to jump to a collaborator's location.
- **Accessibility bar raised**: WCAG 2.2 AA contrast in both themes, visible focus everywhere, focus trapping in every
  dialog, `prefers-reduced-motion` respected, and keyboard-resizable panes. Existing automated a11y checks keep passing.
- **Test compatibility**: existing `data-testid`s and accessible names that e2e and desktop tests rely on are kept,
  or the tests are updated in the same task that changes them.

Not included:
- a WYSIWYG/visual editing mode;
- inline comments and review threads;
- AI features;
- internationalization;
- changes to sync, compile, access-control or server behavior.

## Capabilities

### New Capabilities
- `public-site`: the landing page shown to signed-out web visitors and its paths to sign-up, sign-in, download and
  source.
- `workspace-layout`: the IDE workspace structure: header, activity rail and side panels, resizable editor and PDF
  panes, focus mode, status bar, Share dialog and first-run tour.
- `workspace-commands`: the command palette, keyboard shortcuts, shortcut reference and optional editor keymaps.
- `authoring-aids`: the formatting toolbar, symbol palette, document outline and plain-language compile-error help.
- `project-templates`: creating a project from a bundled template gallery.
- `interface-preferences`: per-device theme (light/dark/system), editor font size and remembered layout.

### Modified Capabilities
- `latex-workspace`: "Accessible and responsive UI" now requires WCAG 2.2 AA contrast in both themes, focus
  management in dialogs, reduced-motion support and keyboard-operable pane resizing.
- `peer-sync`: "Presence" now requires a stable per-collaborator color shared by avatar and cursor, the collaborator's
  current file, and a "follow" action.
- `user-accounts`: "Account registration" now requires feedback on password length and username format while
  typing, before the user submits. Server-side rules are unchanged.

## Impact

- **Code:** `apps/web` almost entirely:
  - `src/app.css` is replaced by a token-based stylesheet;
  - `App.svelte` and every view (`Auth`, `Projects`, `Workspace`, `Account`, `Admin`, `GithubContinue`) and
    component (`FileTree`, `Editor`, `PdfView`, `ChangesPanel`, `ProjectSettings`, `GithubPanel`, `ImportDialog`,
    `ServerChoice`) are restyled or restructured;
  - new components are added (palette, rail, splitter, share dialog, template gallery, outline, symbol palette,
    toast, icons).
- **Desktop:** `apps/desktop` reuses the web build. Its window minimum size and icons may be adjusted; there is no Rust
  logic change.
- **Dependencies:** the Lucide icon set for Svelte, self-hosted font packages (`@fontsource-variable/*`), and the
  optional CodeMirror Vim/Emacs keymaps, lazy-loaded. `@testing-library/svelte` is added for component tests.
- **Tests:**
  - `e2e/*.spec.ts`, `e2e/a11y.spec.ts` and `apps/desktop/e2e/desktop.test.mjs` are updated where structure
    changes;
  - new e2e specs are added for the landing page, palette, templates, share dialog and theme.
- **Bundle size:** `apps/web/check-bundle.mjs` budgets may need to be reviewed. The landing page and templates are
  code-split so the workspace chunk does not grow from them.
- **Protocol:** the presence (awareness) state shared between peers gains the user's open file. Older clients ignore
  the extra field.
- **No API, server, document-format or access-control changes.**
