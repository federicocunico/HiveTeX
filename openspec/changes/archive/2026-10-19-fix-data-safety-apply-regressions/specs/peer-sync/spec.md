# Spec Delta

## ADDED Requirements

### Requirement: Bounded provenance growth
Recording and exchanging authored operations SHALL grow with the size of each change, not with the size of the document.
A replica SHALL NOT store or send a full pre-change copy of a document per edit. Recovery preimages SHALL be captured
only where recovery needs them, such as the start of a change group or a destructive change, and SHALL be stored once
per distinct content.

#### Scenario: Typing in a large document
- **WHEN** a member types 1,000 single characters into a 100 KB text file that is synchronized with one co-author
- **THEN** the history data added on each replica and the bytes sent for those edits stay within a fixed multiple of the typed content plus a bounded per-group overhead, independent of the 100 KB document size

#### Scenario: Destructive change keeps its preimage
- **WHEN** a member deletes most of a file in one edit
- **THEN** the replaced content is retained once and can be recovered exactly

### Requirement: Physical deletions never stall root synchronization
A replica SHALL apply a root update that physically removes file entries it still holds. Before applying it, the replica
SHALL retain each removed entry locally as a recoverable item. It SHALL NOT withhold the rest of the update, and SHALL NOT
rely on a quarantine that only a later update can clear. The member SHALL see that files were removed by a co-author and
can recover them.

#### Scenario: Deletion made before the upgrade while a co-author was offline
- **WHEN** Bob deleted `a.tex` on the previous release while Alice was offline, both upgrade, and Bob also created `b.tex` while Alice was away
- **THEN** after reconnecting Alice receives `b.tex` and Bob's other root changes, `a.tex` is absent from her tree, and its last content is listed in Recovery as removed by Bob's device

#### Scenario: Repeated reconnects
- **WHEN** the same peer reconnects several times after sending a physical deletion
- **THEN** the removed entry is retained only once and later root updates from that peer apply without a quarantine notice

### Requirement: Deletions are compatible with previous clients
A recoverable deletion made by this release SHALL appear to a client of the previous release (0.8.0) as an ordinary
deletion. The file SHALL NOT remain visible, SHALL NOT be written back to that client's bound folder, and SHALL NOT come
back to upgraded replicas through that client.

#### Scenario: Mixed-version project
- **WHEN** an upgraded member deletes `old.tex` while a 0.8.0 co-author is connected with a bound folder
- **THEN** `old.tex` disappears from the co-author's tree and folder, stays recoverable on the upgraded replica, and does not reappear there after the co-author edits other files

### Requirement: Live edits are not delayed by storage or history transfer
Sending a local edit to connected co-authors SHALL NOT wait for a retry of local provenance storage, nor for retained
history being sent to any peer. A storage failure SHALL stay visible and keep retrying while live edits keep flowing. A
history transfer to one peer SHALL NOT delay live edits to other peers.

#### Scenario: Provenance storage failing
- **WHEN** storing authored-operation records fails repeatedly on Alice's replica while she keeps typing
- **THEN** Bob keeps receiving her edits within the normal propagation time and Alice sees a persistent storage warning

#### Scenario: History bootstrap of a new member
- **WHEN** Carol joins and receives retained history from Alice while Alice and Bob keep editing
- **THEN** edits between Alice and Bob keep arriving within the normal propagation time

### Requirement: One bad history record does not stop history synchronization
Paging retained history from a peer SHALL continue past a record that fails verification, cannot be stored, or is not
answered within a bounded time. The skipped record SHALL be reported with its reason. History completeness SHALL be shown
as incomplete rather than as receiving forever.

#### Scenario: Record signed by an untrusted key
- **WHEN** one history record from Bob fails signature verification
- **THEN** the remaining records are received, the failed one is reported as skipped with its reason, and the history status settles as incomplete

### Requirement: Forwarded edits reach previous clients
An upgraded replica that forwards an authored operation SHALL send it to a peer of the previous release in that peer's
supported format. Live edits SHALL reach every connected client within the normal propagation time, whatever the
topology.

#### Scenario: Relay through an upgraded peer
- **WHEN** Alice (upgraded) is connected only to Bob (upgraded), and Bob is connected to Carol (0.8.0)
- **THEN** Alice's edits reach Carol within the normal propagation time without a full resync
