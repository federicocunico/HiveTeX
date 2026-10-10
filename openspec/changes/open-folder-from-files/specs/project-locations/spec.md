## MODIFIED Requirements

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
