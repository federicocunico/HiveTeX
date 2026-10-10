# Spec Delta

## MODIFIED Requirements

### Requirement: Local folder mirror (desktop)
The desktop app, and the web app on browsers supporting the File System Access API, SHALL let a member bind a project to a local folder, including the folder the project was created from or stored in. Project state SHALL be written to the folder as plain files, and changes made to those files by any external program SHALL be merged into the project as normal edits by that member. The folder SHALL be chosen by the user in a native dialog; the app SHALL NOT read or write folders whose path was supplied by page content.

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

### Requirement: Mirror ignores build artifacts
The local folder mirror SHALL ignore build artifacts and tool metadata (e.g. `.aux`, `.log`, `.synctex.gz`, `.git/`,
`.claude/`, `.cursor/`, `node_modules/`), the project marker (`.hivetex.json`, and the legacy marker from before the
rename), and any patterns in a project-level ignore file (`.hivetexignore`, or the legacy ignore file from before the rename).

#### Scenario: Aux files
- **WHEN** a local tool writes `main.aux` into the bound folder
- **THEN** the file is not added to the shared project

#### Scenario: Marker file
- **WHEN** a folder is bound and `.hivetex.json` is written or edited in it
- **THEN** the marker is not added to the shared project
