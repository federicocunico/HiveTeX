## ADDED Requirements

### Requirement: Use the desktop app without an account
The desktop app SHALL let a person use it without signing in, by choosing *Continue without an account* on the sign-in
screen. In local mode the app SHALL NOT contact any HiveTeX server and SHALL NOT send project content or metadata to any
network service. Every workspace feature that does not need other people SHALL work: creating projects from templates,
importing, editing, compiling, history, folders and the Files context menu.

#### Scenario: First start on a plane
- **WHEN** someone starts the freshly installed desktop app without network access and chooses Continue without an account
- **THEN** they reach the projects page and can create a project from a template, edit it and compile a PDF

#### Scenario: No network traffic
- **WHEN** a person works in local mode
- **THEN** no request is made to the HiveTeX server or any signalling endpoint

#### Scenario: Restart
- **WHEN** the app is closed and opened again after local-mode use
- **THEN** it opens in local mode with the local projects listed, without asking to sign in

### Requirement: Local projects
Projects created in local mode SHALL be stored only on this computer and SHALL be listed under *On this computer* on the
projects page, distinct from shared projects. Local projects SHALL remain available after the person signs in or out.

#### Scenario: Listing after sign-in
- **WHEN** a person who created two local projects signs in to an account
- **THEN** the projects page shows their shared projects and, separately, the two local projects

### Requirement: Publish a local project
After signing in, a member SHALL be able to publish a local project: it becomes a shared project with a project ID
and password (as when creating a project), owned by them, whose files are exactly the local project's files. The local
copy SHALL then be that shared project on this computer (its folder, if any, stays linked).

#### Scenario: Publish
- **WHEN** a member publishes local project "thesis" choosing ID `thesis-2026` and a password
- **THEN** the shared project `thesis-2026` exists with all of thesis's files, and co-authors who join it receive them

#### Scenario: ID taken
- **WHEN** the chosen ID is already used
- **THEN** publishing is refused with a suggestion, as for project creation, and the local project is unchanged

### Requirement: Link a local project to an existing project
After signing in, a member SHALL be able to link a local project to an existing shared project by joining it (ID and
password). The local files SHALL be merged into the shared project: files only on one side are kept; files present on
both sides with different content are conflicts resolved as for offline work (see peer-sync), with nothing shared
until each conflicting file is resolved.

#### Scenario: Link with overlap
- **WHEN** a member links local project "draft" to shared project `paper-x`, both having a different `main.tex`
- **THEN** `main.tex` is shown as a conflict to resolve, and every file present on only one side is in the merged project
