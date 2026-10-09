# peer-sync Specification

## Purpose

Keeps every member device's copy of a project (text, images, bibliography) converged in real time and after offline work, by exchanging changes directly between authenticated peers so document content never passes through or rests on the control plane.

## Requirements

### Requirement: Content never touches the control plane
Document sources, binary assets, compiled PDFs and edit operations MUST travel only between member devices (directly or through an encrypted relay that cannot decrypt them) and MUST NOT be stored on or readable by the control plane.

#### Scenario: Control plane inspection
- **WHEN** an operator inspects the control plane database, caches and logs during an active editing session
- **THEN** no document text, file names inside the project, assets or PDFs are present

### Requirement: Peer discovery and connection bootstrap
A member device SHALL discover other online member devices of the project and establish encrypted peer connections. Connection-setup messages relayed by the control plane MUST be end-to-end encrypted between the two devices.

#### Scenario: Second member comes online
- **WHEN** member A is editing and member B opens the same project
- **THEN** A and B establish a direct encrypted connection and B's copy converges with A's

#### Scenario: Already in the mesh
- **WHEN** a device is already connected to at least one peer and a new peer appears
- **THEN** the connection to the new peer MAY be negotiated through existing peers instead of the control plane

### Requirement: Peer authentication
Before exchanging any project data, both peers MUST verify each other's membership ticket and prove possession of the device key named in the ticket, bound to the specific encrypted connection.

#### Scenario: Valid peers
- **WHEN** two devices with valid, unexpired tickets for the same project connect
- **THEN** each verifies the other's ticket and key proof, then sync starts

#### Scenario: Ticket for another project
- **WHEN** a peer presents a valid ticket for a different project
- **THEN** the connection is closed without sending project data

### Requirement: NAT traversal fallback
When a direct connection cannot be established, the system SHALL fall back to a relay that forwards only encrypted traffic.

#### Scenario: Symmetric NAT
- **WHEN** two peers cannot connect directly
- **THEN** they connect through the relay and sync continues, with content still end-to-end encrypted

### Requirement: Conflict-free merging
Concurrent and offline edits SHALL merge automatically and deterministically on every device without creating duplicate files, conflict copies or silent overwrites of other members' text.

#### Scenario: Concurrent edits in different paragraphs
- **WHEN** two editors change different paragraphs of the same file at the same time
- **THEN** both changes appear on every device within 1 second on a healthy connection

#### Scenario: Concurrent edits in the same sentence
- **WHEN** two editors type into the same sentence concurrently
- **THEN** both insertions are preserved and all devices converge to identical text

### Requirement: Offline editing
Editors SHALL be able to open and edit any project already present on their device without network access. Changes SHALL be persisted locally on every keystroke batch and synchronized automatically when a peer becomes reachable.

#### Scenario: Offline then reconnect
- **WHEN** an editor edits offline for hours while a co-author edits the same project online, then reconnects
- **THEN** both sets of changes are merged on all devices with no user action

#### Scenario: Crash safety
- **WHEN** the app or browser tab is killed during editing
- **THEN** on reopen, all edits made more than 1 second before the kill are present

### Requirement: Project file model
A project SHALL contain a tree of text files (e.g. `.tex`, `.bib`, `.sty`, `.cls`) and binary files (e.g. images, PDFs). Creating, renaming, moving and deleting files and folders SHALL sync like content edits.

#### Scenario: Concurrent rename and edit
- **WHEN** one editor renames `intro.tex` to `introduction.tex` while another edits it
- **THEN** all devices end with a single `introduction.tex` containing the edit

### Requirement: Binary asset transfer
Binary files SHALL be transferred by content hash in chunks, fetched on demand from any peer holding them, and verified against their hash before use.

#### Scenario: Image added
- **WHEN** an editor adds a 5 MB image
- **THEN** peers fetch it in verified chunks, possibly from multiple peers, without blocking text sync

#### Scenario: Corrupt chunk
- **WHEN** a received chunk does not match its expected hash
- **THEN** it is discarded and re-requested from another peer

### Requirement: Read-only enforcement
Every peer MUST reject content changes originating from a device whose current ticket role is `viewer`, and MUST NOT forward them.

#### Scenario: Tampered viewer client
- **WHEN** a modified client with a `viewer` ticket sends content changes
- **THEN** honest peers discard them and the changes never appear on other devices

### Requirement: Presence
Connected members SHALL see who else is online in the project and each editor's cursor/selection in the file they view.

#### Scenario: Cursor display
- **WHEN** a co-author moves their cursor in `main.tex`
- **THEN** other members viewing `main.tex` see the cursor labeled with that co-author's username

### Requirement: Initial sync for new members
A new member device SHALL receive the full current project state from any online peer.

#### Scenario: No peer online
- **WHEN** a new member opens a project and no other member device is online
- **THEN** the UI states that no peer is online and offers bootstrap from the linked GitHub backup if one exists and the user has access to it

### Requirement: Local history
Each device SHALL keep restorable snapshots of the project state so an editor can view and restore earlier versions; a restore SHALL sync as a normal edit.

#### Scenario: Restore
- **WHEN** an editor restores a snapshot from yesterday
- **THEN** the project returns to that content on all devices and the restore itself can be undone
