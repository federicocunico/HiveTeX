# Spec Delta

## ADDED Requirements

### Requirement: Recoverable local storage failures
If saving a batch fails, the device SHALL retain unsaved edits, expose a persistent save error, and retry without duplicating or losing edits. A failed write SHALL NOT prevent later saving after storage recovers. The device SHALL report local durability independently of peer synchronization.

#### Scenario: Storage recovers
- **WHEN** saving one batch fails, more edits arrive, and storage becomes writable
- **THEN** retry saves both batches, reopening restores them, and the save error clears only after successful persistence

#### Scenario: Storage remains unavailable
- **WHEN** local writes continue failing while peers remain connected
- **THEN** the workspace warns that edits are not safely stored locally and offers recovery export without claiming they were saved

### Requirement: Durable offline merge checkpoints
Before replacing an offline working copy, the device SHALL durably retain its base, unshared contents, and recovery stage. Recovery data SHALL remain until the merged result or unresolved conflicts are durably saved. Restarting at any interrupted transition SHALL recover the unshared work without duplicating its application.

#### Scenario: Crash during preparation
- **WHEN** the app terminates between saving recovery data and replacing a document
- **THEN** reopening recovers all previously saved offline edits and resumes preparation safely

#### Scenario: Crash during completion
- **WHEN** the app terminates after applying a merged result but before clearing its checkpoint
- **THEN** reopening preserves the result and does not apply the same offline insertion twice

### Requirement: Confirmed input before offline merge
An offline merge SHALL use confirmed remote document state for its current reconciliation attempt. Timeout, disconnection, storage failure, and unavailable content SHALL keep the merge pending with its recovery data intact. Failure to prepare a merge SHALL prevent that attempt from sharing unmerged offline changes.

#### Scenario: Slow or absent response
- **WHEN** a requested remote document does not arrive before the deadline
- **THEN** the merge remains pending, no recovery copy is cleared, and reconnecting retries the exchange

#### Scenario: Failed preparation
- **WHEN** saving the offline recovery copy fails before peer synchronization
- **THEN** document exchange for that attempt is stopped and the device reports a recoverable error

#### Scenario: Late response from an earlier attempt
- **WHEN** a previous peer session's response arrives after reconciliation restarts
- **THEN** it cannot certify completion of the new attempt

### Requirement: Explicit document availability
The device SHALL distinguish locally complete content, missing content, and content awaiting reconciliation. An allocated document or a file-table entry SHALL NOT establish completeness. Operations that consume a complete project SHALL wait for all required content or report what remains unavailable. Known empty files SHALL count as complete.

#### Scenario: File list arrives first
- **WHEN** a file is listed but its text has not arrived
- **THEN** the device reports it as unavailable and does not treat its temporary empty representation as the file's content

#### Scenario: Confirmed empty document
- **WHEN** a peer confirms a file is empty or the device creates an empty local file
- **THEN** the file is available without waiting for a nonempty update

### Requirement: Safe identical-file consolidation
Automatic consolidation of files with the same path SHALL require complete matching contents and unchanged file identities and revisions at the point of deletion. Missing or still-reconciling documents SHALL remain distinct. Concurrent changes SHALL invalidate an earlier equality decision.

#### Scenario: Two delayed file bodies
- **WHEN** two same-path file entries arrive before their different text contents
- **THEN** neither entry is deleted as an identical duplicate

#### Scenario: Edit during comparison
- **WHEN** a file changes while its equality with another file is being checked
- **THEN** both files are retained until a fresh comparison establishes equality

### Requirement: Automatic synchronization recovery
When connectivity returns after offline startup, a shared project SHALL recover its registered device identity, trusted keys, and membership ticket and resume peer discovery without reopening. Discovery presence SHALL stay accurate during idle connected sessions. Relay credentials SHALL be refreshed before new connections use expired credentials, and temporary credential failures SHALL remain retryable.

#### Scenario: Open without the control plane
- **WHEN** a previously stored shared project opens while the control plane is unavailable and connectivity later returns
- **THEN** the project reconnects automatically and safely reconciles edits made in the meantime

#### Scenario: Idle peer is discoverable
- **WHEN** a peer remains connected to signaling beyond the presence expiry interval and another member joins
- **THEN** both discover each other regardless of which device normally initiates their connection

#### Scenario: Reconnect after relay credential expiry
- **WHEN** a relay-dependent peer must reconnect after its previous credentials expire
- **THEN** the device obtains fresh credentials and retries without a reload

### Requirement: Connection lifecycle isolation
Only one current connection attempt per remote device SHALL own its negotiation state. Pausing or closing a project SHALL cancel pending setup and prevent its delayed callbacks from opening connections or restarting work. Delayed callbacks from older attempts and signaling sessions SHALL NOT replace or invalidate newer ones.

#### Scenario: Duplicate discovery during setup
- **WHEN** signaling and peer exchange announce the same device while connection configuration is loading
- **THEN** they share one current attempt and no orphan connection is created

#### Scenario: Stop during setup
- **WHEN** the member pauses synchronization while setup awaits configuration
- **THEN** later completion of that configuration does not create a connection or transmit signaling

### Requirement: Bounded and cancellable peer transport
Peer messages SHALL have bounded fragment assembly, decoded payload size, queued bytes, and incomplete-message lifetime. Blob receivers SHALL enforce chunk size and aggregate file size before retaining bytes. Closing a connection SHALL settle its pending sends and release partial transfers. Malformed traffic from one peer SHALL NOT block healthy peer editing.

#### Scenario: Close during backpressure
- **WHEN** a channel closes while a send waits for its buffer to drain
- **THEN** the pending send and queued sends terminate with a connection error without waiting for a drain event

#### Scenario: Oversized chunk with a plausible count
- **WHEN** a peer declares a valid chunk count but sends a chunk larger than the permitted chunk size
- **THEN** the chunk is rejected before it is retained and another eligible source can be tried

#### Scenario: Incomplete fragment stream
- **WHEN** a peer sends fragments without completing a message or exceeds the receive budget
- **THEN** retained data is bounded and the invalid transfer is terminated

### Requirement: Automatic retry for missing content
Missing content SHALL be retried with bounded backoff while an eligible source is available. A new source, new content identity, or reconciliation attempt SHALL invalidate a previous failed fetch even when the number of files and peers is unchanged. Unrelated activity SHALL NOT conceal a stalled missing transfer.

#### Scenario: Asset becomes available later
- **WHEN** an image fetch fails and a connected peer later announces that image
- **THEN** the device retries automatically and completes receipt without manual sync

#### Scenario: Active file while another is stalled
- **WHEN** edits keep arriving for one file while another file makes no progress for 60 seconds
- **THEN** the missing transfer still produces a stalled notification

## MODIFIED Requirements

### Requirement: Sync progress visibility
A device SHALL expose, and the workspace SHALL show, the current sync stage and a progress figure: the stage (offline,
looking for co-authors, connecting, receiving, up to date), how many files are received of how many are known, and the
time of the last successful sync. A text file counts as received once its content has been exchanged with a peer, and a
binary file once its verified content is stored on the device. Cached content and receipts from earlier connections SHALL NOT alone establish that the current reconciliation is up to date. The workspace SHALL distinguish content availability, local save status, and current peer reconciliation.

#### Scenario: Join in progress
- **WHEN** a new member joins a project of 200 files and 60 have arrived
- **THEN** the workspace shows the stage "receiving", "60 of 200 files" and a percentage of 30%

#### Scenario: Nothing to receive
- **WHEN** every known file is received and no peer has anything newer
- **THEN** the stage is "up to date" and the last sync time is shown

#### Scenario: Waiting for a co-author
- **WHEN** a member opens a project for which no co-author is online
- **THEN** the stage says no co-author is online and no progress percentage is claimed

#### Scenario: Reconnected cached project
- **WHEN** a device reconnects with all files cached but has not reconciled with the current peers
- **THEN** its cached files remain usable while the workspace reports reconciliation pending instead of advancing the last successful sync time

### Requirement: Manual sync
The workspace SHALL offer a "Sync now" action to every member. It SHALL reconnect to co-authors that are online but not
connected, re-request the state of every file from every connected peer, and fetch every file not yet received. It
SHALL report the outcome and update the last sync time only after the requested reconciliation succeeds. Queueing requests SHALL NOT count as success; timeout or unavailable content SHALL produce a pending or failed outcome that preserves local edits.

#### Scenario: Stalled join
- **WHEN** a member whose join looks stuck activates "Sync now" while a co-author is online
- **THEN** the connection to that co-author is retried at once, progress resumes, and the outcome is reported

#### Scenario: No co-author online
- **WHEN** a member activates "Sync now" and nobody else is online
- **THEN** the message says no co-author is online and that edits are kept on this device

#### Scenario: Requests sent but no response
- **WHEN** manual sync queues requests and the peer does not answer
- **THEN** the action does not claim completion or advance the successful sync time
