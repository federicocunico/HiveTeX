# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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
