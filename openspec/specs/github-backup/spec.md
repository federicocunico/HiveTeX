# github-backup Specification

## Purpose

Lets a project owner keep an automatic copy of the project in a GitHub repository, committed directly from a member's device on a configurable schedule, which also serves as a way to recover or bootstrap the project when no peer is online.

## Requirements

### Requirement: GitHub linking
A user SHALL be able to connect their GitHub account with access limited to repositories they select. GitHub access tokens SHALL be stored only on the user's device and SHALL NOT be persisted by the control plane. The authorization flow SHALL only deliver a token to the same user and device that started it.

#### Scenario: Connect GitHub
- **WHEN** a user completes the GitHub authorization flow
- **THEN** their device holds a token scoped to the selected repositories and the control plane stores only the GitHub username link

#### Scenario: Forwarded authorization link
- **WHEN** user A starts linking GitHub and sends the authorization URL to user B, who opens it and authorizes
- **THEN** no token is delivered to A's device, B's GitHub account is not linked to A, and B sees that the link could not be completed

### Requirement: Project-to-repository binding
An owner SHALL be able to bind a project to a new or existing GitHub repository and branch. Only owners SHALL change the binding. The binding recorded on the control plane by an owner SHALL be the only repository the backup writer pushes to.

#### Scenario: Create new private repo
- **WHEN** an owner chooses "Back up to new private repository"
- **THEN** a private repository is created and the current project state is committed to it

#### Scenario: Binding changed by a non-owner peer
- **WHEN** an editor's device writes a different repository into the shared project metadata
- **THEN** the backup writer does not push to that repository and the backup status shows that the binding does not match the owner's setting

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
If the bound branch contains commits not made by HiveTeX, the backup SHALL NOT force-push; it SHALL push to a separate `hivetex/backup` branch and notify the owner.

#### Scenario: Manual commit on GitHub
- **WHEN** someone pushed a manual commit to the bound branch
- **THEN** the next backup goes to `hivetex/backup` and owners see a divergence notice

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
