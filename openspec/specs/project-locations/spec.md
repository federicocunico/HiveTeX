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

### Requirement: Browser folders are read-only imports
Browser folder access SHALL be import-only. Browser clients SHALL NOT write, remove or continuously mirror files in a picked external directory. Native desktop adapters MAY provide live folder sync using retained originals and exclusive publication. Importing SHALL preserve the external directory and use the normal import preview, attribution and recovery mechanisms for changes to the project.

#### Scenario: Browser import followed by project edits
- **WHEN** a member imports a folder and then edits or deletes its imported files in the browser project
- **THEN** the original folder remains unchanged and no live folder mirror is bound

#### Scenario: Legacy browser folder binding
- **WHEN** an upgraded browser opens a project with a remembered external directory handle
- **THEN** it detaches that binding without writing to the folder, retains the project in app storage and explains how to import again

### Requirement: Unreadable files are not deleted files
A bound folder SHALL distinguish confirmed absence from read, permission, lock, I/O and incomplete-scan failures. Failures SHALL pause affected reconciliation, preserve project and folder contents, expose an actionable error and retry. They SHALL NOT generate shared deletions or empty replacements.

#### Scenario: Browser permission revoked
- **WHEN** access to an existing file fails because browser folder permission was revoked
- **THEN** the file remains in the project and the member is asked to restore access, without propagating a deletion

#### Scenario: Temporarily locked Windows file
- **WHEN** antivirus or another process temporarily prevents reading a bound file
- **THEN** the current shared copy remains intact and reading is retried without interpreting the failure as absence

#### Scenario: Incomplete directory enumeration
- **WHEN** listing part of a bound folder fails
- **THEN** unlisted entries are not treated as deletions and reconciliation reports the failed scan

### Requirement: Destructive folder reconciliation preserves external work
Before removing, replacing or renaming a mirrored file, the device SHALL verify its current disk content against the last agreed state. Unimported external changes SHALL be preserved durably and exposed as a conflict when necessary. Permission changes or process failure SHALL NOT cause an unrecorded destructive write.

#### Scenario: Remote deletion before watcher delivery
- **WHEN** a remote deletion arrives after an external tool changed the local file but before its watcher event is processed
- **THEN** the external version is preserved for recovery and resolution before the file is removed from the folder

#### Scenario: Remote rename and pending disk edit
- **WHEN** a remote rename races an unimported edit under the old path
- **THEN** the edited content remains accessible under the stable file identity or in an explicit recovery conflict

#### Scenario: Viewer has an external modification
- **WHEN** a viewer changes a folder file and the project copy must be restored
- **THEN** the unauthorized edit is preserved for local recovery but is not published to co-authors

### Requirement: Atomic folder replacement
Folder writes SHALL either replace a complete file atomically or preserve the previous file and report failure. Temporary writes SHALL be isolated per destination and attempt. Retrying after a lock or failed commit SHALL NOT truncate the original file or confuse another file's temporary content.

#### Scenario: Rename remains locked
- **WHEN** the filesystem refuses committing a prepared replacement
- **THEN** the old file remains intact, the write is retried and no in-place truncation fallback occurs

#### Scenario: Files share a basename
- **WHEN** `main.tex` and `main.bib` are written concurrently
- **THEN** their staged data cannot overwrite or commit each other's content

### Requirement: Host filename collisions preserve both files
When project paths cannot coexist on the host filesystem, mirroring SHALL preserve all project versions and report the collision. Case folding, reserved names, Unicode equivalence and file-versus-directory collisions SHALL NOT overwrite an unrelated file or make a successful complete-mirror claim.

#### Scenario: Case-insensitive destination
- **WHEN** a project contains distinct `Intro.tex` and `intro.tex` and the destination treats them as the same name
- **THEN** both shared files remain intact and the member is offered an explicit safe mapping or a project rename

#### Scenario: File blocks a directory
- **WHEN** a project contains a file `sections` and a different file `sections/a.tex`
- **THEN** mirroring reports the incompatible paths without deleting the existing file to create a directory

### Requirement: Folder writes on filesystems without hard links
Publishing a file to a bound folder SHALL keep the target path present with either its previous or its new content.
This SHALL hold on filesystems without hard-link support (FAT32, exFAT, some network and cloud-backed drives). A
publication failure SHALL leave the previous content at the target path and report a folder error. A failed
publication SHALL NOT be followed by a shared deletion.

#### Scenario: Project folder on an exFAT drive
- **WHEN** a co-author's edit is written to `main.tex` in a folder on an exFAT USB drive
- **THEN** `main.tex` contains the new content, no copy of it is left only in the recovery directory, and no deletion is sent to peers

#### Scenario: Publication fails after the original was set aside
- **WHEN** the new content cannot be published to the target path
- **THEN** the previous content is back at the target path before the error is reported

### Requirement: Recovery copies are bounded and only for external work
A bound folder SHALL keep a recovery copy only when the bytes about to be replaced or removed differ from what HiveTeX
last wrote or read there. Kept copies SHALL follow a documented retention limit and SHALL NOT be synchronized or uploaded
by the app.

#### Scenario: Co-author typing
- **WHEN** a co-author types continuously for an hour in a file that is mirrored to a bound folder
- **THEN** the folder's recovery directory gains no copies for those writes

#### Scenario: External edit before replacement
- **WHEN** an external editor saved changes that HiveTeX had not read, and a co-author's edit then replaces the file
- **THEN** exactly one recovery copy holds the external bytes, and it is listed in Recovery

### Requirement: Folder errors are isolated per path
One file that cannot be written, read or removed SHALL NOT stop reconciliation of the other files in the folder. Retries
SHALL back off. A retry of one kind SHALL NOT cancel a retry of another kind. Directory change events SHALL NOT be
treated as file read failures.

#### Scenario: File locked by another program
- **WHEN** a co-author deletes `figs/old.pdf` while it is open in a viewer that blocks renames, and adds `figs/new.png`
- **THEN** `figs/new.png` appears in the folder, the deletion of `figs/old.pdf` is retried with backoff and shown as pending, and both settle once the viewer closes

#### Scenario: Folder created on disk
- **WHEN** a new subdirectory is created in the bound folder
- **THEN** no read-error notice or retry loop starts for the directory path

#### Scenario: Drive disconnects and returns
- **WHEN** the drive holding the folder disconnects during a write and reconnects
- **THEN** project-to-folder writes resume without restarting the app
