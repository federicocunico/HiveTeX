# Spec Delta

## ADDED Requirements

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
