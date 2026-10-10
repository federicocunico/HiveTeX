# Spec Delta

## Purpose
Keeps the product consistently presented as HiveTeX, and makes renames safe for people who already have data on their
devices or in their folders and repositories.

## ADDED Requirements

### Requirement: One product name
Everything a user sees SHALL use the name HiveTeX, including:
- the application and window title;
- installer and application bundle names;
- release names and emails;
- the web interface and documentation;
- command-line output.

#### Scenario: Installer names
- **WHEN** a release is built
- **THEN** the Windows installer is named `HiveTeX_<version>_x64-setup.exe`, and the installed application shows
  "HiveTeX" in its window title and in the system's app list

#### Scenario: Emails
- **WHEN** a user registers
- **THEN** the verification email is sent from and signed as HiveTeX

### Requirement: Data from the previous name is kept
On first start after the rename, the app SHALL carry over, once and without user action, what the device stored under
the previous name:
- device keys;
- local copies of projects;
- remembered folder locations;
- settings;
- (desktop) the credentials kept in the OS keychain.

After the migration, the app SHALL use only the new names.

#### Scenario: Existing device keys and projects
- **WHEN** a device that used the previous version starts the renamed app
- **THEN** the user stays registered on the same device, their projects open with their offline copies, and their
  folders are still bound

#### Scenario: Migration runs once
- **WHEN** the renamed app starts again later
- **THEN** no data is copied again and old entries are not read

### Requirement: Files written under the previous name are recognised
Folders and repositories created before the rename SHALL keep working:
- a project marker or ignore file with the previous name SHALL be read;
- the next write SHALL use the new name and remove the old marker;
- backup commits carrying the previous backup trailer SHALL count as the app's own commits.

#### Scenario: Old marker in a folder
- **WHEN** a user opens a folder that contains the legacy marker file naming one of their projects
- **THEN** the project opens with the folder bound, and the folder then contains `.hivetex.json` instead of
  the legacy marker file

#### Scenario: Old ignore file
- **WHEN** a bound folder has the legacy ignore file and no `.hivetexignore`
- **THEN** its patterns are applied

#### Scenario: Earlier backups are not a divergence
- **WHEN** the bound branch's last commit is a backup made under the previous name
- **THEN** the next backup continues on the bound branch instead of diverting to the backup branch
