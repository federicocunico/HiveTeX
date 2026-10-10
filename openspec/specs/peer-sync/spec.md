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
A member device SHALL discover other online member devices of the project and establish encrypted peer connections. Connection-setup messages relayed by the control plane MUST be end-to-end encrypted between the two devices. A device SHALL prove possession of its device key to the signaling relay before it is announced to other members. The ending of an earlier connection of a device SHALL NOT affect a newer connection of the same device.

#### Scenario: Second member comes online
- **WHEN** member A is editing and member B opens the same project
- **THEN** A and B establish a direct encrypted connection and B's copy converges with A's

#### Scenario: Already in the mesh
- **WHEN** a device is already connected to at least one peer and a new peer appears
- **THEN** the connection to the new peer MAY be negotiated through existing peers instead of the control plane

#### Scenario: Copied ticket
- **WHEN** a member connects to the signaling relay with another member's ticket but without that device's private key
- **THEN** the relay refuses the connection and other members see no presence change for that device

#### Scenario: Quick reload of the same device
- **WHEN** a member reloads the app and the old signaling session's cleanup is processed after the new session announced itself
- **THEN** the device stays present and its peers keep the new connection

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
Binary files SHALL be transferred by content hash in chunks, fetched on demand from any peer holding them, and verified against their hash before use. A transfer whose declared size exceeds the project's maximum file size SHALL be rejected.

#### Scenario: Image added
- **WHEN** an editor adds a 5 MB image
- **THEN** peers fetch it in verified chunks, possibly from multiple peers, without blocking text sync

#### Scenario: Corrupt chunk
- **WHEN** a received chunk does not match its expected hash
- **THEN** it is discarded and re-requested from another peer

#### Scenario: Oversized transfer
- **WHEN** a peer announces a chunk count implying a blob larger than the maximum file size
- **THEN** the receiving device ignores that transfer without allocating memory for it and tries other peers

### Requirement: Read-only enforcement
Every peer MUST reject content changes originating from a device whose current ticket role is `viewer`, and MUST NOT forward them.

#### Scenario: Tampered viewer client
- **WHEN** a modified client with a `viewer` ticket sends content changes
- **THEN** honest peers discard them and the changes never appear on other devices

### Requirement: Presence
Connected members SHALL see who else is online in the project and each editor's cursor/selection in the file they view.
Each member SHALL have one color, derived from their account so it stays the same across projects and devices. That
color SHALL mark their avatar, cursor, selection and the files they have open. Members SHALL see which file each
online co-author is in. A co-author known to be online but not yet connected SHALL be listed as "connecting" and SHALL
NOT be counted as connected.

#### Scenario: Cursor display
- **WHEN** a co-author moves their cursor in `main.tex`
- **THEN** other members viewing `main.tex` see the cursor labeled with that co-author's username

#### Scenario: Same color everywhere
- **WHEN** Ada is online in two projects that Federico also has open on two devices
- **THEN** Ada's avatar, cursor and selection have the same color in both projects and on both devices

#### Scenario: Where co-authors are
- **WHEN** Ada has `intro.tex` open
- **THEN** her avatar's tooltip says "intro.tex", and `intro.tex` in the file tree shows a dot in her color

#### Scenario: Online but not connected
- **WHEN** Ada is online (visible to the signaling relay) and the connection to her is still being set up
- **THEN** the people list shows Ada as "connecting" instead of "No co-authors online"

### Requirement: Initial sync for new members
A new member device SHALL receive the full current project state from any online peer, and SHALL show its progress
while it does.

#### Scenario: No peer online
- **WHEN** a new member opens a project and no other member device is online
- **THEN** the UI states that no peer is online and offers bootstrap from the linked GitHub backup if one exists and the user has access to it

#### Scenario: Slow initial sync
- **WHEN** a new member joins and the transfer takes minutes
- **THEN** the member sees the stage and progress throughout, and never an "all synced" message while files are missing

### Requirement: Local history
Each device SHALL keep restorable snapshots of the project state so an editor can view and restore earlier versions; a restore SHALL sync as a normal edit.

#### Scenario: Restore
- **WHEN** an editor restores a snapshot from yesterday
- **THEN** the project returns to that content on all devices and the restore itself can be undone

### Requirement: Real-time propagation at group scale
With up to 12 connected member devices on a healthy connection, an edit SHALL reach every other device within 250 ms at the 95th percentile, and each edit SHALL be sent at most once over each peer connection in a fully connected mesh. When some devices cannot connect directly, edits SHALL still reach every device through the others.

#### Scenario: Seven co-authors typing
- **WHEN** seven members are connected and one types a character
- **THEN** the other six see it within 250 ms (95th percentile over a typing session)

#### Scenario: Everyone types at once
- **WHEN** all connected members type concurrently in the same file
- **THEN** every device converges to identical text containing every insertion

#### Scenario: No duplicate relaying in a full mesh
- **WHEN** twelve devices are all directly connected and one edits a file
- **THEN** the edit is sent once to each of the eleven others and is not forwarded again by them

#### Scenario: Partial mesh
- **WHEN** devices A and B cannot connect directly but both are connected to C
- **THEN** A's edits reach B through C, without duplicates being re-forwarded endlessly

#### Scenario: Connection attempt that stalls
- **WHEN** a connection attempt between two members never completes and never reports a failure (lost signaling message, overloaded machine)
- **THEN** it is abandoned after a timeout and retried with backoff until the two members are connected

### Requirement: Follow a collaborator
A member SHALL be able to follow an online co-author from their avatar. While following, the member's editor SHALL
open the co-author's file and keep their cursor in view. Following SHALL stop when the member types, scrolls or picks
another file, or when the co-author goes offline. The followed avatar SHALL be visibly marked.

#### Scenario: Follow and stop
- **WHEN** Federico chooses "Follow" on Kenji's avatar, Kenji moves from `main.tex` to `method.tex`, and Federico then
  scrolls
- **THEN** Federico's editor switches to `method.tex` and tracks Kenji's cursor until the scroll, after which
  following stops and the mark disappears

### Requirement: Distinguishable presence colors
Presence colors SHALL have at least 3:1 contrast against the editor background in both themes. A cursor label SHALL
always show the username, so color is never the only way to identify a person.

#### Scenario: Color is not the only cue
- **WHEN** two co-authors with similar colors are in the same file
- **THEN** each cursor shows its username label

### Requirement: Sync progress visibility
A device SHALL expose, and the workspace SHALL show, the current sync stage and a progress figure: the stage (offline,
looking for co-authors, connecting, receiving, up to date), how many files are received of how many are known, and the
time of the last successful sync. A text file counts as received once its content has been exchanged with a peer, and a
binary file once its verified content is stored on the device.

#### Scenario: Join in progress
- **WHEN** a new member joins a project of 200 files and 60 have arrived
- **THEN** the workspace shows the stage "receiving", "60 of 200 files" and a percentage of 30%

#### Scenario: Nothing to receive
- **WHEN** every known file is received and no peer has anything newer
- **THEN** the stage is "up to date" and the last sync time is shown

#### Scenario: Waiting for a co-author
- **WHEN** a member opens a project for which no co-author is online
- **THEN** the stage says no co-author is online and no progress percentage is claimed

### Requirement: File list before contents
As soon as the project's file list reaches the device, it SHALL be shown even if file contents have not arrived. Each
file SHALL have a visible sync state: received, waiting, receiving, or being edited by a named co-author.

#### Scenario: List first
- **WHEN** the file list has arrived but no text file content has
- **THEN** the file tree lists every file name and marks each as not yet received

#### Scenario: Co-author editing
- **WHEN** Ada has `intro.tex` open and is typing
- **THEN** `intro.tex` is marked as being edited by Ada, in her color, in the file tree and in the sync list

### Requirement: Manual sync
The workspace SHALL offer a "Sync now" action to every member. It SHALL reconnect to co-authors that are online but not
connected, re-request the state of every file from every connected peer, and fetch every file not yet received. It
SHALL report the outcome and update the last sync time.

#### Scenario: Stalled join
- **WHEN** a member whose join looks stuck activates "Sync now" while a co-author is online
- **THEN** the connection to that co-author is retried at once, progress resumes, and the outcome is reported

#### Scenario: No co-author online
- **WHEN** a member activates "Sync now" and nobody else is online
- **THEN** the message says no co-author is online and that edits are kept on this device

### Requirement: Sync notifications
When a join or sync completes, and when it makes no progress for 60 seconds while a co-author is online and files are
missing, the workspace SHALL show a short notification that says which of the two happened.

#### Scenario: Join completes
- **WHEN** the last missing file is received
- **THEN** a notification says all files are received

#### Scenario: Sync stalls
- **WHEN** a co-author is online and no progress happens for 60 seconds with files still missing
- **THEN** a notification says the sync is slow or stuck and points to "Sync now"

### Requirement: Persistent link retry
A device SHALL keep trying to connect to every co-author that is online, with backoff capped at 30 seconds, and SHALL NOT
stop trying after a fixed number of failures.

#### Scenario: Long network trouble
- **WHEN** more than 8 consecutive attempts to reach an online co-author fail and the network then recovers
- **THEN** the devices connect without any user action
