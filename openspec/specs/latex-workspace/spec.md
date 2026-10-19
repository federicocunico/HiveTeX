# latex-workspace Specification

## Purpose

Defines the user-facing workspace — LaTeX editor, file tree and PDF preview — available both as a web app and as a desktop app, and the desktop's on-disk folder mirror that lets local AI/coding tools (Claude Code, Codex, Cursor, etc.) work on a project.

## Requirements

### Requirement: Two delivery modes with one feature set
The workspace SHALL be available as a web app served from the public deployment and as an installable desktop app for Windows, macOS and Linux. Both SHALL interoperate in the same project. The desktop app SHALL use the hosted control plane over the network, and the control plane SHALL accept those cross-origin requests from the desktop app only.

#### Scenario: Mixed clients
- **WHEN** one member uses the web app and another uses the desktop app on the same project
- **THEN** their sources synchronize and each device builds and previews its own PDF locally

#### Scenario: Desktop signs in to the hosted control plane
- **WHEN** a user signs in from the desktop app pointed at the public deployment
- **THEN** sign-in, project list, tickets and relay credentials work as in the web app

#### Scenario: Other websites
- **WHEN** a page on another website calls the control plane API from a visitor's browser
- **THEN** the browser blocks the response because that origin is not allowed

### Requirement: LaTeX editor
The editor SHALL provide LaTeX/BibTeX syntax highlighting, bracket matching, command and `\ref`/`\cite` completion from the project's labels and bibliography, search/replace across the project, and inline display of compile errors. A selection SHALL be visibly highlighted on every line it covers, including the line holding the cursor, in both themes; the current-line highlight SHALL NOT hide any part of a selection.

#### Scenario: Citation completion
- **WHEN** an editor types `\cite{` in a project whose `.bib` defines `knuth84`
- **THEN** `knuth84` is offered as a completion

#### Scenario: Selection visible to its last line
- **WHEN** a member selects lines 3 to 6 by dragging the mouse or with Shift+Down, ending on line 6
- **THEN** lines 3, 4, 5 and the selected part of line 6 are all shown highlighted, as they are after Ctrl+A

### Requirement: File tree operations
Editors SHALL create, upload, rename, move and delete files and folders; viewers SHALL only browse and download. The Files panel SHALL offer these actions in a context menu, opened with the right mouse button, the context-menu key or Shift+F10 on a file, a folder or the panel's empty area, and operable with the keyboard. A file's menu SHALL also offer opening it and, for `.tex` files, setting it as the main document. On the desktop app, every menu SHALL also offer opening the project's folder in the system file manager, opening a terminal in it, copying its path, and showing the item in the file manager. Viewers SHALL see only the actions that do not change the project.

#### Scenario: Upload image
- **WHEN** an editor drags an image into the file tree
- **THEN** it is added to the project and becomes available to all peers

#### Scenario: Context menu on a file
- **WHEN** an editor right-clicks `sections/intro.tex`
- **THEN** a menu offers Open, Rename or move, Delete, Set as main document, Download and, on the desktop app, Open folder, Open in terminal, Copy folder path and Show in file manager

#### Scenario: Keyboard
- **WHEN** a member focuses a file in the tree and presses Shift+F10
- **THEN** the same menu opens with its first item focused, arrow keys move between items, Enter runs one and Escape closes it, returning focus to the file

#### Scenario: Viewer
- **WHEN** a viewer opens the menu on a file
- **THEN** only Open, Download and the folder actions are offered

### Requirement: PDF preview
The workspace SHALL render the current PDF with zoom, page navigation and source/PDF jumps, and SHALL indicate whether the PDF is up to date with the latest edits and which compiler on this machine produced it.

#### Scenario: Stale indicator
- **WHEN** edits exist that are newer than the displayed PDF
- **THEN** the preview shows an "outdated" indicator until a successful local build of current inputs replaces it

### Requirement: Project export
Any member SHALL be able to download the full project source as a zip archive and the latest PDF.

#### Scenario: Export
- **WHEN** a member clicks "Download source"
- **THEN** a zip containing the current file tree is saved locally

### Requirement: Import
A signed-in user SHALL be able to create a project from an uploaded zip archive or from a GitHub repository they can access.

#### Scenario: Zip import
- **WHEN** a user creates a project from a zip with `main.tex` and `figures/`
- **THEN** the project contains those files and `main.tex` is set as the main file

### Requirement: Local folder mirror (desktop)
The desktop app, and the web app on browsers supporting the File System Access API, SHALL let a member bind a project to a local folder, including the folder the project was created from or stored in. Project state SHALL be written to the folder as plain files, and changes made to those files by any external program (edits, new files, deletes and renames) SHALL be merged into the project as normal edits by that member and reach co-authors in real time. The folder SHALL be one the user chose in a native dialog, or one the desktop app itself created for the project under the member's HiveTeX projects folder at the member's request; the app SHALL NOT read or write folders whose path was supplied by page content.

#### Scenario: External AI tool edits a file
- **WHEN** Claude Code (or any program) modifies `sections/method.tex` in the bound folder
- **THEN** the change appears in the editor and on co-authors' devices as an edit attributed to the local member

#### Scenario: Remote edit while folder is bound
- **WHEN** a co-author edits `main.tex` remotely
- **THEN** the bound folder's `main.tex` is updated on disk within 1 second

#### Scenario: Viewer folder
- **WHEN** a viewer binds a folder and an external program modifies a file in it
- **THEN** the change is not propagated, the file is restored to project state, and the user is notified

#### Scenario: Path supplied by script
- **WHEN** script running in the app asks the native side to mirror or import a folder by path, without the user picking it
- **THEN** the request is refused and no file outside user-picked folders is read or written

#### Scenario: Edits while the app was closed
- **WHEN** an AI tool edits files in a bound folder while HiveTeX is not running, and the member then opens the project
- **THEN** those edits are merged into the project as the member's edits, alongside anything co-authors changed meanwhile

#### Scenario: New file from an AI tool
- **WHEN** a program creates `sections/related.tex` in the bound folder while the project is open
- **THEN** the file appears in the Files panel within a second and on co-authors' devices, as the member's addition

### Requirement: Mirror ignores build artifacts
The local folder mirror SHALL ignore build artifacts and tool metadata (e.g. `.aux`, `.log`, `.synctex.gz`, `.git/`,
`.claude/`, `.cursor/`, `node_modules/`), the project marker (`.hivetex.json`), and any patterns in a project-level
ignore file (`.hivetexignore`).

#### Scenario: Aux files
- **WHEN** a local tool writes `main.aux` into the bound folder
- **THEN** the file is not added to the shared project

#### Scenario: Marker file
- **WHEN** a folder is bound and `.hivetex.json` is written or edited in it
- **THEN** the marker is not added to the shared project

### Requirement: Local-only AI usage
The product SHALL NOT send project content to any AI service itself; AI assistance happens only through tools the user runs locally on the mirrored folder.

#### Scenario: No built-in upload
- **WHEN** a user works with the app without configuring any external tool
- **THEN** no project content leaves the device except to authenticated peers and, if enabled, the user's GitHub backup

### Requirement: Accessible and responsive UI
The workspace SHALL be keyboard-navigable and remain usable on screens down to 1024 px wide; project list and
settings SHALL also work on phone-sized screens. In addition:
- text and controls SHALL meet WCAG 2.2 AA contrast in both themes;
- every interactive element SHALL show a visible focus indicator;
- every dialog SHALL move focus into itself on open, keep focus inside while open, close with Escape, and return focus
  to the control that opened it.

#### Scenario: Keyboard only
- **WHEN** a user navigates the file tree, editor and preview using only the keyboard
- **THEN** all primary actions are reachable

#### Scenario: Contrast in both themes
- **WHEN** the automated accessibility check runs on the landing, sign-in, registration, projects and workspace
  screens in the light theme and again in the dark theme
- **THEN** it reports no serious or critical violations, including color-contrast

#### Scenario: Dialog focus
- **WHEN** a keyboard user opens the Share dialog, presses Tab repeatedly and then Escape
- **THEN** focus cycles only within the dialog, and after Escape it returns to the Share button

#### Scenario: Narrow window
- **WHEN** the workspace is shown at 1024 px wide with a long user name and project name
- **THEN** nothing overflows horizontally and the header actions remain reachable

### Requirement: Mirror imports only complete file writes
The desktop folder mirror SHALL import a file change from disk only once the file content is stable, so a file caught in the middle of being rewritten (for example truncated before new content is written) is never merged into the project.

#### Scenario: Tool rewrites a file while a co-author types
- **WHEN** an external program rewrites `main.tex` in the bound folder (truncating it first) while a co-author appends a line remotely
- **THEN** every device ends with the program's change and the co-author's line in their correct places, with no content lost or reordered

### Requirement: Editor follows the current selection
The editor SHALL display and edit only the currently selected file in the active project. Completion of an earlier file load or document replacement SHALL NOT restore an obsolete binding. Closing the editor SHALL prevent pending loads from recreating it. Rebinding SHALL release the previous editor and undo resources.

#### Scenario: Rapid file switching
- **WHEN** the member selects file A and then file B while A loads slowly
- **THEN** B remains the only active editor even if A finishes last, and typing changes B only

#### Scenario: Close during loading
- **WHEN** a project closes while its editor awaits a file
- **THEN** completion does not recreate an editor or mutate the closed project

### Requirement: Complete source exports
Source export SHALL capture a complete consistent file set, distinguishing unavailable content from empty content. If required content cannot be obtained, export SHALL report the missing files without presenting an incomplete archive as the full project. A complete local project SHALL remain exportable offline.

#### Scenario: Export during initial transfer
- **WHEN** a member requests source export after the file list arrives but before a text body arrives
- **THEN** export waits for that body or reports it unavailable instead of substituting an empty file

### Requirement: Folder reconciliation preserves concurrent work
Folder reconciliation SHALL retain a common baseline whenever disk and project contents agree, including immediately after binding. Concurrent disk and peer edits SHALL be merged from that baseline without silently overwriting either side. Overlapping changes that cannot be merged safely SHALL retain both versions and require resolution. Unavailable project content SHALL NOT overwrite disk files.

#### Scenario: Matching folder followed by concurrent edits
- **WHEN** disk and project match at bind time, a peer then edits the file, and a local tool edits the previous disk version
- **THEN** non-overlapping edits from both sides survive in the project and on disk

#### Scenario: Partial project at bind time
- **WHEN** the project knows a file's name but has not received its content and the folder contains that file
- **THEN** the folder content is preserved until reconciliation can distinguish missing content from an intentional empty file

#### Scenario: Overlap after reopening
- **WHEN** both the saved project and the folder changed the same lines while the app was closed
- **THEN** both versions remain recoverable and the member resolves the overlap before a destructive replacement

### Requirement: Viewer-safe initial folder binding
Binding or reopening a viewer's folder SHALL NOT produce project content mutations, including initial import or reconciliation. A folder file that differs from available project content SHALL be restored from the project with a notice. A folder file that is not part of the project SHALL be left on disk, unshared, with a notice, because the file list may still be incomplete. A file whose project content has not arrived SHALL be compared once it is complete. Later external changes follow the read-only policy.

#### Scenario: Viewer binds a different folder copy
- **WHEN** a viewer binds a folder whose existing text differs from the project
- **THEN** the project remains unchanged and the viewer is informed of the read-only reconciliation outcome

#### Scenario: Viewer folder has a file the project does not
- **WHEN** a viewer binds a folder containing `extra.tex`, which is not in the project
- **THEN** `extra.tex` stays on disk unchanged, is not shared, and the viewer is told it is not part of the project

#### Scenario: New file after binding
- **WHEN** a program creates a new file in a viewer's bound folder after binding
- **THEN** the file is removed and the viewer is told the change was reverted
