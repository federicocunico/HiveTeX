# peer-sync Specification

## Purpose

Keeps every member device's copy of a project (text, images, bibliography) converged in real time and after offline work, by exchanging changes directly between authenticated peers so document content never passes through or rests on the control plane.

## Requirements

### Requirement: Content never touches the control plane
Document sources, binary assets, compiled PDFs and edit operations MUST travel only between member devices (directly or through an encrypted relay that cannot decrypt them) and MUST NOT be stored on or readable by the control plane. A relay co-hosted on the same infrastructure SHALL forward only transient ciphertext, without retaining content payloads in databases, caches or logs.

#### Scenario: Control plane inspection
- **WHEN** an operator inspects the control plane database, caches and logs during an active editing session
- **THEN** no document text, file names inside the project, assets or PDFs are present

#### Scenario: Co-hosted relay inspection
- **WHEN** devices exchange project data through the server's relay role
- **THEN** only routing metadata and transient ciphertext are available to that role, and no payload archive or plaintext content is stored

#### Scenario: All source devices offline
- **WHEN** no authorized device holding the project is available
- **THEN** the application relay cannot bootstrap a new member from server storage and the existing no-source status applies

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
When a direct connection cannot be established, capable clients SHALL use configured TURN when it works and otherwise an end-to-end encrypted application relay on the existing server when the deployment enables it, it is reachable and within budget, without requiring a separately configured TURN provider. The application relay SHALL be a last resort and disabled unless the deployment enables it. Desktop automatic port mapping SHALL supplement direct connectivity without blocking either relay path.

#### Scenario: Symmetric NAT
- **WHEN** two peers cannot connect directly
- **THEN** they connect through the relay and sync continues, with content still end-to-end encrypted

#### Scenario: UPnP mapping fails
- **WHEN** automatic port mapping is unavailable, rejected or ineffective
- **THEN** the peers can still establish an ordinary direct connection or use configured TURN or the application relay without manual port configuration

### Requirement: Conflict-free merging
Concurrent edits made while devices are linked SHALL merge automatically and deterministically on every device without creating duplicate files, conflict copies or silent overwrites of other members' text. Edits made while a device had no peer linked are merged as described in *Offline editing*.

#### Scenario: Concurrent edits in different paragraphs
- **WHEN** two editors change different paragraphs of the same file at the same time
- **THEN** both changes appear on every device within 1 second on a healthy connection

#### Scenario: Concurrent edits in the same sentence
- **WHEN** two editors type into the same sentence concurrently
- **THEN** both insertions are preserved and all devices converge to identical text

### Requirement: Offline editing
Editors SHALL be able to open and edit any project already present on their device without network access. Changes SHALL be persisted locally on every keystroke batch. Edits a device makes while no peer is linked (no network, *Work offline*, local mode, or nobody else online) SHALL be kept on that device until its next link, and then merged per file, three-way by lines, against the state both sides last shared:
- a file changed on only one side SHALL take that side's version without any prompt;
- changes to different lines of the same file SHALL be merged automatically and the member SHALL be told which files were merged this way;
- changes to the same lines SHALL be conflicts, resolved by the member before that file's merged version is shared;
- a file added on one side SHALL be added; a file deleted on one side and unchanged on the other SHALL be deleted;
- a file deleted on one side and changed on the other, renamed to different paths on both sides, or a binary file changed on both sides SHALL be a conflict with an explicit choice.

Offline edits SHALL never be lost: until resolved, the member's version of a conflicting file stays on their device.

#### Scenario: Offline then reconnect
- **WHEN** an editor edits offline for hours while a co-author edits the same project online, then reconnects
- **THEN** files changed by only one of them are merged on all devices with no user action

#### Scenario: Crash safety
- **WHEN** the app or browser tab is killed during editing
- **THEN** on reopen, all edits made more than 1 second before the kill are present

#### Scenario: Different parts of the same file
- **WHEN** an editor rewrote the introduction of `main.tex` offline while a co-author rewrote its conclusion
- **THEN** both rewrites are in `main.tex` on all devices and the editor sees "Merged your offline changes: main.tex (also changed by others)"

#### Scenario: Same lines
- **WHEN** both rewrote the same paragraph of `main.tex`
- **THEN** `main.tex` is listed as a conflict, the co-author keeps seeing their version, and the merged result is shared only after the editor resolves it

#### Scenario: App closed during an unresolved conflict
- **WHEN** the editor closes the app with a conflict unresolved and opens it again
- **THEN** the conflict is still listed with both versions and nothing was lost

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
A new member device SHALL receive the full current project state from an online peer authorized to supply it, including a desktop background seed, and SHALL show its progress while it does. Viewer-only availability SHALL NOT be treated as an authoritative bootstrap source.

#### Scenario: No peer online
- **WHEN** a new member opens a project and no other member device is online
- **THEN** the UI states that no peer is online and offers bootstrap from the linked GitHub backup if one exists and the user has access to it

#### Scenario: Slow initial sync
- **WHEN** a new member joins and the transfer takes minutes
- **THEN** the member sees the stage and progress throughout, and never an "all synced" message while files are missing

#### Scenario: Only a background seed is online
- **WHEN** a new member opens a project whose only available source is a complete owner/editor desktop seed
- **THEN** initial sync completes from that seed without its editor being opened

#### Scenario: Only viewers are online
- **WHEN** a new member has no project content and only viewers are connected
- **THEN** the UI explains that an owner/editor source is required and does not claim successful bootstrap

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

### Requirement: Resolving merge conflicts
The workspace SHALL show a conflict count while offline work has conflicts, and a resolve view listing each conflicting file. For each conflict in a text file it SHALL show the base, the member's version and the others' version, and offer *keep mine*, *keep theirs*, *keep both* (mine first) and editing the result by hand. For file-level conflicts it SHALL offer the applicable choices: keep the file or delete it, choose a path, choose a binary version. Once every conflict of a file is decided, the file's merged version SHALL be applied as the member's edit and shared; the member SHALL be able to undo it like any edit.

#### Scenario: Keep both
- **WHEN** the member chooses keep both for a conflicting paragraph
- **THEN** the merged file contains their paragraph followed by the others' paragraph, and it is shared with co-authors

#### Scenario: Partly resolved
- **WHEN** a file has two conflicts and the member resolves one
- **THEN** the file is not shared yet and the remaining conflict stays listed

#### Scenario: Viewer
- **WHEN** a viewer's device had offline edits (which viewers cannot make) or the member lost edit rights meanwhile
- **THEN** no merge is offered and the local differences are discarded with a notice, as for read-only enforcement

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
Only one current connection attempt per remote device SHALL own its negotiation state. Pausing or stopping project synchronization SHALL cancel pending setup and prevent delayed callbacks from opening connections or restarting work. Detaching a desktop workspace SHALL retain an enabled seed session. Delayed callbacks from older attempts and signaling sessions SHALL NOT replace or invalidate newer ones.

#### Scenario: Duplicate discovery during setup
- **WHEN** signaling and peer exchange announce the same device while connection configuration is loading
- **THEN** they share one current attempt and no orphan connection is created

#### Scenario: Stop during setup
- **WHEN** the member pauses synchronization while setup awaits configuration
- **THEN** later completion of that configuration does not create a connection or transmit signaling

#### Scenario: Desktop workspace detachment
- **WHEN** a desktop member navigates away from an enabled seed project
- **THEN** its connection ownership stays with the background session and a late UI callback cannot destroy it

#### Scenario: Browser workspace closure
- **WHEN** a browser member closes a project workspace
- **THEN** its in-page session stops and delayed setup cannot reopen its connections

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

### Requirement: Offline work when only viewers are linked
A viewer SHALL NOT be asked to confirm state for an offline merge and SHALL NOT be treated as holding work to merge
with. When the only co-authors linked to a member who can edit are viewers, that member's offline work SHALL be shared
as it is, at once, without waiting for an editor. An editor who links later SHALL merge against the shared state. A
member who lost edit rights SHALL keep the existing behavior: their offline differences are discarded with a notice.

#### Scenario: Only a viewer is online
- **WHEN** an editor with offline work reconnects and the only linked co-author is a viewer
- **THEN** no confirmation is requested, the work is shared at once, and the viewer receives it

#### Scenario: An editor links later
- **WHEN** an editor who changed the same file while unlinked links after the work was shared
- **THEN** their changes are merged with the shared state, and any overlapping change becomes a conflict to resolve

### Requirement: Background seed availability
Peers SHALL distinguish background device availability from an attached editor's cursor and viewed file. Detaching the last editor SHALL clear its cursor and viewed-file presence while retaining authenticated seed availability for connected peers. A dormant seed SHALL be reachable through the doorbell rather than through continuous server presence. Presence extensions SHALL interoperate with peers that do not understand seeding status.

#### Scenario: Person leaves the editor
- **WHEN** a member closes a workspace but its desktop seed stays online
- **THEN** updated peers show background availability without a stale cursor or a claim that the person is editing a file

#### Scenario: Dormant seed is needed
- **WHEN** a member opens a project whose only source is a dormant desktop seed
- **THEN** the member's client rings the project and the seed comes online and supplies the project without its editor being opened

#### Scenario: Older peer
- **WHEN** an existing supported browser or desktop version connects to a new seed
- **THEN** document synchronization still works, unknown optional presence fields are ignored and the application relay is used only after capability negotiation

### Requirement: Application relay session authentication
Before project data crosses the application relay, peers SHALL verify current same-project membership and possession of the ticket's device key, bound to a fresh encrypted session. Relay keys SHALL be separated from signaling keys. Forged, reflected, replayed or wrong-context traffic SHALL be rejected. Ticket expiry, revocation and viewer restrictions SHALL apply as on WebRTC.

#### Scenario: Replayed encrypted traffic
- **WHEN** a previously delivered encrypted frame is replayed in the same session or after reconnect
- **THEN** it cannot apply an edit again or authenticate a replacement session

#### Scenario: Session or recipient substitution
- **WHEN** an intermediary changes a handshake identity, channel context, recipient or session binding
- **THEN** authentication fails before any project content is exchanged

#### Scenario: Permission changes during relay use
- **WHEN** a relay-connected editor is demoted or their ticket expires
- **THEN** current authorization is enforced and buffered work cannot regain the earlier permissions

### Requirement: Bounded reliable application relay delivery
Application relay delivery SHALL tolerate transient loss, duplication and reordering with bounded buffers and retry. Server acceptance SHALL NOT establish peer receipt, local durability or synchronization completion. When delivery cannot recover, the link SHALL fail visibly and reconcile from member-held state after reconnection.

#### Scenario: Publish succeeds but recipient misses it
- **WHEN** the server accepts ciphertext but the recipient's subscription drops before receipt
- **THEN** the sender retries within its limits or reports pending delivery without claiming synchronization

#### Scenario: WebSocket lifetime expires
- **WHEN** a hosting duration limit closes the signaling socket during a relay transfer
- **THEN** the clients reconnect, establish fresh authorization and encryption, and reconcile missing work without reopening the project

#### Scenario: Relay backpressure
- **WHEN** a receiver or cross-instance backend cannot keep up
- **THEN** queues remain bounded, control traffic is protected and stalled sends terminate or remain explicitly pending

### Requirement: Safe transport selection
Clients SHALL prefer a healthy direct connection, then configured TURN, and attempt the application relay when connection setup fails or exceeds a bounded deadline. UPnP and optional TURN configuration SHALL NOT be prerequisites for this fallback. A later transport switch SHALL preserve edits and current authorization with one authoritative peer connection generation.

#### Scenario: Direct and TURN unavailable
- **WHEN** two capable peers can reach the application server but direct WebRTC and TURN are unavailable
- **THEN** they attempt authenticated application relay setup within 10 seconds of learning each other's available relay capability

#### Scenario: Direct connectivity recovers
- **WHEN** a working direct path becomes available while peers use the application relay
- **THEN** a coordinated authenticated handover resumes synchronization without lost edits, duplicate active ownership or stale callbacks

#### Scenario: Relay unavailable too
- **WHEN** direct, TURN and application relay paths cannot connect
- **THEN** the app preserves local edits, reports unavailability and retries with bounded backoff rather than promising guaranteed connectivity

### Requirement: Zero idle control-plane cost
A device with no connected peer need and no introduction in progress SHALL hold no connection to the control plane and SHALL send no presence heartbeats, ticket renewals or polling requests. Signaling sockets SHALL exist only while an introduction is in progress or an application-relay session needs them, and SHALL close once the wanted links are authenticated or the introduction window ends. Connected peers SHALL keep exchanging edits without the control plane.

#### Scenario: Idle seed overnight
- **WHEN** a desktop seed has no peer and nobody rings its projects for hours
- **THEN** it makes no request to the control plane and holds no signaling socket during that time

#### Scenario: Editing with connected peers
- **WHEN** members are connected to each other and edit
- **THEN** no device keeps a gatekeeper socket open and edits do not use the control plane

### Requirement: Doorbell wake-up
Members SHALL reach devices that are not connected by publishing a short-lived ring token, signed by the control plane after a membership check, to a per-project ring topic on a push channel the devices subscribe to. Ring topics SHALL change with the membership epoch and SHALL not reveal project or user identifiers. Ring requests SHALL be rate-limited.

#### Scenario: Newcomer wakes a dormant seed
- **WHEN** a new member opens a project whose only owner/editor device is a dormant desktop seed
- **THEN** the seed is woken, introduced through the control plane and the member's initial sync proceeds

#### Scenario: Removed member rings
- **WHEN** a member removed from the project publishes to the ring topic it knew before
- **THEN** the topic is no longer subscribed after the epoch change and no device wakes

#### Scenario: Ring answered by a mesh
- **WHEN** several connected members receive the same ring
- **THEN** one representative of their mesh answers and the others are reached through peer exchange

#### Scenario: Push channel unavailable
- **WHEN** a device cannot subscribe to the push channel
- **THEN** its status says the project is reachable only while open, its established links and editing continue, and subscription retries are bounded

### Requirement: Ring token verification
Devices SHALL verify ring tokens offline and SHALL ignore forged, expired, replayed, wrong-topic or older-epoch tokens without network activity. Wake-ups SHALL be rate-limited per device. Ring tokens SHALL NOT grant any project access: woken peers authenticate with tickets and device keys as before.

#### Scenario: Replayed ring
- **WHEN** a previously published ring token is delivered again or after its expiry
- **THEN** no device opens a connection because of it

#### Scenario: Forged ring
- **WHEN** a ring message is not signed by the control plane or names another topic or an older epoch
- **THEN** the device ignores it without contacting the control plane

### Requirement: Application relay budgets
The server SHALL enforce aggregate and per-principal limits on relay bytes, messages, connections, connection time and queued work before forwarding. Text and control traffic SHALL take priority over bulk transfers within those limits. Assets exceeding available budget SHALL remain pending. Quota errors SHALL identify the retry condition without terminating unrelated healthy direct links.

#### Scenario: Asset consumes remaining budget
- **WHEN** a binary transfer would exhaust its allowed relay budget
- **THEN** bulk transfer is deferred, local work stays intact and the UI distinguishes missing content from received text

#### Scenario: Several accounts or instances compete
- **WHEN** many authenticated sessions on different server instances send relay traffic
- **THEN** they cannot bypass the deployment budget by reconnecting, changing projects or opening more connections

#### Scenario: Cost accounting unavailable
- **WHEN** the relay cannot obtain a valid forwarding budget
- **THEN** it refuses new application payload forwarding, exposes the failure and preserves ordinary direct synchronization

### Requirement: Additive relay capability negotiation
Application relay support SHALL be negotiated between the server and both peers. Existing peers and servers that do not support it SHALL retain their WebRTC behavior. Unknown capability announcements SHALL NOT be treated as proof of a usable or authenticated relay connection.

#### Scenario: Older peer or server
- **WHEN** one participant or the server lacks the relay capability
- **THEN** clients continue existing direct or configured TURN attempts and report fallback unavailable without sending unsupported mandatory messages

### Requirement: Relay route and progress visibility
Clients SHALL distinguish direct WebRTC, TURN and application relay routes, including a relay-limited state. Router mapping status SHALL remain separate. Content availability, local durability and current peer reconciliation SHALL remain independently reported for every route.

#### Scenario: Text received while image is deferred
- **WHEN** text has reconciled but an image awaits relay budget
- **THEN** the project remains incomplete, the image has a visible pending reason and no full-project sync completion is claimed

### Requirement: Early connection-setup messages are retained
A device SHALL NOT discard a connection-setup message (including network candidates) for a peer merely because it arrives before that device has finished creating its side of the connection; it SHALL apply them once the connection exists.

#### Scenario: Candidates before the link exists
- **WHEN** candidates from the offering device arrive while the answering device is still obtaining connection configuration
- **THEN** they are applied after the offer is processed and the connection can use them

### Requirement: Failed attempts record a cause
Every failed or timed-out connection attempt SHALL record the stage reached and a cause (no setup reply, no candidates received, checks failed, relay unavailable), available to the user interface.

#### Scenario: Timeout cause
- **WHEN** an attempt times out after checks started with no working pair
- **THEN** the recorded cause says connectivity checks failed rather than only "timed out"
