# Spec Delta

## Purpose

Defines the user-facing workspace — LaTeX editor, file tree and PDF preview — available both as a web app and as a desktop app, and the desktop's on-disk folder mirror that lets local AI/coding tools (Claude Code, Codex, Cursor, etc.) work on a project.

## ADDED Requirements

### Requirement: Two delivery modes with one feature set
The workspace SHALL be available as a web app served from the public deployment and as an installable desktop app for Windows, macOS and Linux. Both SHALL interoperate in the same project.

#### Scenario: Mixed clients
- **WHEN** one member uses the web app and another uses the desktop app on the same project
- **THEN** they edit together and see the same compiled PDF

### Requirement: LaTeX editor
The editor SHALL provide LaTeX/BibTeX syntax highlighting, bracket matching, command and `\ref`/`\cite` completion from the project's labels and bibliography, search/replace across the project, and inline display of compile errors.

#### Scenario: Citation completion
- **WHEN** an editor types `\cite{` in a project whose `.bib` defines `knuth84`
- **THEN** `knuth84` is offered as a completion

### Requirement: File tree operations
Editors SHALL create, upload, rename, move and delete files and folders; viewers SHALL only browse and download.

#### Scenario: Upload image
- **WHEN** an editor drags an image into the file tree
- **THEN** it is added to the project and becomes available to all peers

### Requirement: PDF preview
The workspace SHALL render the current PDF with zoom, page navigation and source/PDF jumps, and SHALL indicate whether the PDF is up to date with the latest edits and which device compiled it.

#### Scenario: Stale indicator
- **WHEN** edits exist that are newer than the displayed PDF
- **THEN** the preview shows an "outdated" indicator until a newer PDF arrives

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
The desktop app SHALL let a member bind a project to a local folder. Project state SHALL be written to the folder as plain files, and changes made to those files by any external program SHALL be merged into the project as normal edits by that member.

#### Scenario: External AI tool edits a file
- **WHEN** Claude Code (or any program) modifies `sections/method.tex` in the bound folder
- **THEN** the change appears in the editor and on co-authors' devices as an edit attributed to the local member

#### Scenario: Remote edit while folder is bound
- **WHEN** a co-author edits `main.tex` remotely
- **THEN** the bound folder's `main.tex` is updated on disk within 1 second

#### Scenario: Viewer folder
- **WHEN** a viewer binds a folder and an external program modifies a file in it
- **THEN** the change is not propagated, the file is restored to project state, and the user is notified

### Requirement: Mirror ignores build artifacts
The local folder mirror SHALL ignore build artifacts and tool metadata (e.g. `.aux`, `.log`, `.synctex.gz`, `.git/`, `.claude/`, `.cursor/`, `node_modules/`) and any patterns in a project-level ignore file.

#### Scenario: Aux files
- **WHEN** a local tool writes `main.aux` into the bound folder
- **THEN** the file is not added to the shared project

### Requirement: Local-only AI usage
The product SHALL NOT send project content to any AI service itself; AI assistance happens only through tools the user runs locally on the mirrored folder.

#### Scenario: No built-in upload
- **WHEN** a user works with the app without configuring any external tool
- **THEN** no project content leaves the device except to authenticated peers and, if enabled, the user's GitHub backup

### Requirement: Accessible and responsive UI
The workspace SHALL be keyboard-navigable and remain usable on screens down to 1024 px wide; project list and settings SHALL also work on phone-sized screens.

#### Scenario: Keyboard only
- **WHEN** a user navigates the file tree, editor and preview using only the keyboard
- **THEN** all primary actions are reachable
