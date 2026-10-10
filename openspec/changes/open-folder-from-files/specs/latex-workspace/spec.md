## MODIFIED Requirements

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
