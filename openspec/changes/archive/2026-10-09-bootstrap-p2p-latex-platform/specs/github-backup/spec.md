# Spec Delta

## Purpose

Lets a project owner keep an automatic copy of the project in a GitHub repository, committed directly from a member's device on a configurable schedule, which also serves as a way to recover or bootstrap the project when no peer is online.

## ADDED Requirements

### Requirement: GitHub linking
A user SHALL be able to connect their GitHub account with access limited to repositories they select. GitHub access tokens SHALL be stored only on the user's device and SHALL NOT be persisted by the control plane.

#### Scenario: Connect GitHub
- **WHEN** a user completes the GitHub authorization flow
- **THEN** their device holds a token scoped to the selected repositories and the control plane stores only the GitHub username link

### Requirement: Project-to-repository binding
An owner SHALL be able to bind a project to a new or existing GitHub repository and branch. Only owners SHALL change the binding.

#### Scenario: Create new private repo
- **WHEN** an owner chooses "Back up to new private repository"
- **THEN** a private repository is created and the current project state is committed to it

### Requirement: Backup policies
The owner SHALL configure when automatic backups happen: after every N accepted changes, after T minutes without edits, or both; plus manual "Back up now". Defaults SHALL be: after 15 minutes idle, and at most once every 5 minutes.

#### Scenario: Idle backup
- **WHEN** no edits occur for the configured idle time after a change
- **THEN** one commit containing the current state is pushed

#### Scenario: Change-count backup
- **WHEN** the configured number of changes accumulates since the last backup
- **THEN** a commit is pushed, respecting the minimum interval

### Requirement: Single backup writer
At most one online device per project SHALL perform automatic backups at a time, chosen among connected devices of members holding a valid GitHub token for the bound repository.

#### Scenario: Two owners online
- **WHEN** two owners with valid tokens are online
- **THEN** exactly one of them pushes each automatic backup

### Requirement: Commit content
Each backup commit SHALL contain the project source files (not build artifacts) and a message listing contributing usernames and time range. The compiled PDF SHALL be included only if the owner enables it.

#### Scenario: Commit message
- **WHEN** a backup is pushed after edits by `alice` and `bob`
- **THEN** the commit message names both and the time range of the edits

### Requirement: Remote divergence handling
If the bound branch contains commits not made by p2platex, the backup SHALL NOT force-push; it SHALL push to a separate `p2platex/backup` branch and notify the owner.

#### Scenario: Manual commit on GitHub
- **WHEN** someone pushed a manual commit to the bound branch
- **THEN** the next backup goes to `p2platex/backup` and owners see a divergence notice

### Requirement: Bootstrap from GitHub
A member with access to the bound repository SHALL be able to load the project from its latest backup when no peer is online, and SHALL merge with peers once they appear.

#### Scenario: Owner offline
- **WHEN** a member with repo access opens a project while no peer is online
- **THEN** they can load the last backup and edit; changes merge once peers reconnect

### Requirement: Backup status visibility
Members SHALL see the last successful backup time, the commit link, and any backup errors.

#### Scenario: Token revoked
- **WHEN** the backup device's GitHub token has been revoked
- **THEN** backups stop, owners see "GitHub authorization expired", and another eligible device takes over if available
