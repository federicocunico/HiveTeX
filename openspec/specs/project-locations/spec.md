# project-locations Specification

## Purpose
Lets each user decide where a project lives on each of their devices (inside the app or in a folder of their choice), and open existing folders, such as cloned repositories, as projects, while the files stay ordinary files usable without the app.

## Requirements

### Requirement: Choose where a project lives
When creating or opening a project on the desktop app or on a Chromium-based browser, a member SHALL be able to keep it in the app's internal storage or in a folder they pick. The choice SHALL be per device and changeable at any time. On the desktop app, asking to open a project's folder or a terminal in it (or to copy its path) while the project is kept in internal storage SHALL put the project in a new folder named after the project ID inside a `HiveTeX` folder in the member's Documents folder, without further questions, and then perform the request. If a folder of that name exists and is not this project's, the app SHALL use the next free name (`<project ID>-2`, `-3`, …).

#### Scenario: Create a project in a folder
- **WHEN** a user creates a project and chooses "Store in a folder…" with an empty folder
- **THEN** the project is created, the folder is bound, and every file of the project appears in it as a plain file

#### Scenario: Move an existing project to a folder
- **WHEN** a member chooses "Use a folder for this project…" in an open project
- **THEN** the project's files are written to that folder and later edits on either side stay in sync

#### Scenario: Stop using a folder
- **WHEN** a member chooses "Stop using this folder"
- **THEN** the project keeps working from internal storage and the folder's files are left untouched on disk

#### Scenario: Open folder of a project kept in the app
- **WHEN** a member right-clicks the Files panel of project `thesis-2026`, kept in internal storage on this computer, and chooses Open folder
- **THEN** `Documents/HiveTeX/thesis-2026` is created with every project file in it, the project is bound to it, and the folder opens in the system file manager

#### Scenario: Folder name already taken
- **WHEN** `Documents/HiveTeX/thesis-2026` already exists and holds another project or unrelated files
- **THEN** the project is put in `Documents/HiveTeX/thesis-2026-2` and nothing in the existing folder is changed

#### Scenario: Terminal ready for an AI tool
- **WHEN** a member chooses Open in terminal
- **THEN** the system's terminal opens with the project folder as its working directory, where running `claude` or `codex` edits the project's files

### Requirement: Open a folder as a project
A user SHALL be able to open any folder from the projects page. If the folder carries a project marker for a project
the user can access, that project SHALL open with the folder bound. Otherwise the user SHALL be offered to create a new
project from the folder.

#### Scenario: Folder of a known project
- **WHEN** a member opens a folder whose `.hivetex.json` names a project they belong to
- **THEN** that project opens with the folder bound, and edits made in the folder while the app was closed are merged

#### Scenario: Cloned backup of a project the user has not joined
- **WHEN** a user opens a clone of a project's GitHub backup and is not yet a member
- **THEN** the join form opens pre-filled with the project ID; after joining, the project opens with the folder bound

#### Scenario: Create a project from a folder
- **WHEN** a user opens a folder with LaTeX sources and no marker, and confirms "Create a project from this folder"
- **THEN** a new project is created whose tree equals the folder's (minus ignored build artifacts and tool folders), the
  main file and compiler are detected as for imports, and the folder stays bound

#### Scenario: Folder with a marker for another server or a deleted project
- **WHEN** the marker names a project that does not exist or is not accessible
- **THEN** the user is told so and offered to create a new project from the folder; the folder's files are not modified
  until they confirm

### Requirement: Folder marker
A bound folder SHALL contain a `.hivetex.json` file identifying the project (format version, project ID, project ID
slug), without secrets or document content. The marker SHALL never be synced as a project file. The GitHub backup SHALL
write the same identity so clones are recognised.

#### Scenario: Marker written on bind
- **WHEN** a folder is bound to project `my-paper`
- **THEN** `.hivetex.json` in the folder contains that project's identity, and the file does not appear in the project
  tree

#### Scenario: Backup carries identity
- **WHEN** the GitHub backup pushes a project
- **THEN** the repository's `.hivetex.json` contains the project identity and the backed-up paths

### Requirement: Remembered locations per device
Each device SHALL remember which folder (if any) each project uses and SHALL re-bind it when the project is opened, asking again only when the folder is missing or access must be re-granted.

#### Scenario: Reopen
- **WHEN** a member reopens a project that uses a folder on this device
- **THEN** the folder is bound again without picking it, and the projects page shows the folder's name for that project

#### Scenario: Folder moved or deleted
- **WHEN** the remembered folder no longer exists
- **THEN** the project opens from internal storage and the member is offered to pick the folder again or stop using it

### Requirement: Folders in the web app
On browsers that support the File System Access API (Chromium-based), the web app SHALL offer the same folder features as the desktop app. Access SHALL be limited to folders the user picked, SHALL require the user's permission again in each new browser session, and changes made by other programs SHALL be detected within 3 seconds. Other browsers SHALL explain that folders need the desktop app or a Chromium-based browser.

#### Scenario: Re-grant after restart
- **WHEN** a member reopens a folder-bound project in a new browser session
- **THEN** a single "Allow access to <folder>" action restores the binding

#### Scenario: AI tool edits on the web
- **WHEN** Claude Code edits a file in a folder bound in Chrome
- **THEN** the change appears in the editor within 3 seconds and syncs to co-authors

#### Scenario: Unsupported browser
- **WHEN** a member uses Firefox
- **THEN** folder actions are shown as unavailable with an explanation, and import/export still work
