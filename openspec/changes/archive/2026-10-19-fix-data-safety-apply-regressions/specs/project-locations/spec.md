# Spec Delta

## ADDED Requirements

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
