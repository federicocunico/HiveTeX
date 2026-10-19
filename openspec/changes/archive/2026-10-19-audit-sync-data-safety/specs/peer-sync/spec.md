# Spec Delta

## MODIFIED Requirements

### Requirement: Conflict-free merging
Concurrent text edits made while devices are linked SHALL merge automatically and deterministically on every device without silent overwrites of other members' text. Concurrent structural changes SHALL preserve all competing content and expose unresolved choices. Edits made while a device had no peer linked are merged as described in *Offline editing*.

#### Scenario: Concurrent edits in different paragraphs
- **WHEN** two editors change different paragraphs of the same file at the same time
- **THEN** both changes appear on every device within 1 second on a healthy connection

#### Scenario: Concurrent edits in the same sentence
- **WHEN** two editors type into the same sentence concurrently
- **THEN** both insertions are preserved and all devices converge to identical text

#### Scenario: Linked delete versus edit
- **WHEN** one connected editor deletes a file while another changes its text, path or binary content without observing that deletion
- **THEN** every replica preserves the deletion and competing version as a recoverable conflict, identifies their authors and offers an explicit resolution

### Requirement: Local history
Each device SHALL keep restorable project versions and recoverable deletions. Restoring SHALL be a recorded collaborative edit, with a durable recovery point before destructive changes. Snapshot contents and settings SHALL describe one coherent project state; unavailable content SHALL be reported rather than replaced with empty data.

#### Scenario: Restore
- **WHEN** an editor restores a snapshot from yesterday
- **THEN** the project returns to that content on all devices and the restore itself can be undone

#### Scenario: Edit during snapshot acquisition
- **WHEN** a member changes the tree or a file while a project version is being captured
- **THEN** the saved version represents a coherent captured state, including main file and engine, or capture retries or fails explicitly

## ADDED Requirements

### Requirement: Recoverable deletions
Removing a file from the active project SHALL retain its stable identity, path, author, causal context and recoverable content on member devices before acknowledging durable deletion. Synchronization SHALL NOT infer deletion from unavailable content. Recovery SHALL include text, binary assets and directory contents within the advertised retention window.

#### Scenario: Deleted file not opened this session
- **WHEN** a member deletes a previously stored text file without opening it
- **THEN** its complete previous content remains recoverable after restart and can be restored from the deleted-files view

#### Scenario: Storage refuses recovery data
- **WHEN** recovery information for a destructive change cannot be stored
- **THEN** the device preserves its current copy, reports the failure and does not acknowledge the destructive change as durably saved

#### Scenario: Delayed peer after deletion
- **WHEN** a device reconnects with an edit based on a version predating a retained deletion
- **THEN** the edit is retained and exposed for resolution rather than silently discarded or used to resurrect the file

### Requirement: Original provenance survives synchronization
Peers SHALL exchange the original identity and integrity evidence of recorded operations along with the causal references needed to interpret them. Reforwarding or receiving an aggregate state SHALL NOT attribute all included changes to its sender. Unverifiable historical authorship SHALL be labelled unknown and SHALL NOT grant edit permission.

#### Scenario: Three-peer chain
- **WHEN** Alice's change reaches Carol only through Bob
- **THEN** Carol's history attributes the change to Alice and can distinguish Bob as the forwarding device

#### Scenario: New device receives existing history
- **WHEN** an authorized device bootstraps from a complete peer
- **THEN** it can inspect retained authorship, versions and deletions after synchronization, with unavailable older history explicitly identified

#### Scenario: Legacy destructive update
- **WHEN** an older peer sends a destructive change without the required recovery or provenance information
- **THEN** the receiver retains its previous content, exposes the compatibility limitation and quarantines the unsafe change instead of silently applying an irreversible deletion

### Requirement: Conservative recovery migration
Upgrading a replica SHALL preserve existing documents, assets, snapshots and pending or denied edits. Retained documents absent from the active tree SHALL be available for explicit local recovery without automatically rejoining the shared project. Migration failures or unsupported formats SHALL preserve the original store.

#### Scenario: Existing orphaned text
- **WHEN** an upgraded store contains a text document whose file entry was previously deleted
- **THEN** the member can export or inspect the recoverable content even if the original path or author is unknown

#### Scenario: Recovery after membership removal
- **WHEN** a removed member retains a local replica
- **THEN** recovery remains local and does not restore network authorization or automatically publish retained changes
