# Spec Delta

## MODIFIED Requirements

### Requirement: Change sets
Each device SHALL record every project mutation as a durable operation with a stable identifier, original user and device identity, source, causal references, time and affected files. Consecutive operations from the same source SHALL be grouped into display change sets after a few idle seconds without mixing other sources' contributions or losing operation boundaries.

#### Scenario: AI tool session
- **WHEN** Claude Code edits three files in the bound folder within a few seconds
- **THEN** one change set "Folder on this device" lists those three files with the time and identifies the owning user and device, without claiming to identify the external process

#### Scenario: Co-author edits
- **WHEN** co-author Ada edits `intro.tex`
- **THEN** a change set attributed to Ada appears on every other device, including when forwarded by a different co-author

#### Scenario: First edit of a lazy document
- **WHEN** a member opens a previously stored file after project startup and immediately edits it
- **THEN** that edit is recorded against the persisted baseline, without treating it as initial loading

#### Scenario: Interleaved sources
- **WHEN** a folder edit and an editor edit affect the same file during the grouping interval
- **THEN** each change set includes only its source's operations and undoing either preserves the other contribution unless an explicit conflict is resolved

#### Scenario: Edit then rename
- **WHEN** a member edits and renames a file within one grouping interval
- **THEN** the change set retains both content and path changes and can reverse both

### Requirement: Undo a change set
A member with edit rights SHALL be able to undo a change set as a recorded collaborative edit. Undo SHALL reverse only that set's operations, preserve later non-overlapping edits and retain a recovery point. Unsafe inversions SHALL expose conflicts without partially applying destructive guesses. Repeating the same undo request SHALL NOT apply it twice.

#### Scenario: Undo an AI edit after others typed
- **WHEN** a member undoes the folder change set that rewrote a paragraph, after Ada edited another paragraph of the same file
- **THEN** the rewritten paragraph returns to its previous text, Ada's edit remains, and every device converges

#### Scenario: Viewer
- **WHEN** a viewer opens the Changes view
- **THEN** they can review change sets but no undo action is offered

#### Scenario: Undo creation after later contribution
- **WHEN** a member undoes creation of a file that another operation subsequently edited
- **THEN** the later work remains recoverable and the action presents a conflict instead of silently deleting the file

#### Scenario: Undo binary replacement after another replacement
- **WHEN** a member undoes a binary change whose resulting content has since been replaced
- **THEN** the subsequent asset is preserved and the incompatible inversion requires a visible choice

#### Scenario: Overlapping inverse patch
- **WHEN** an inverse text operation overlaps later edits
- **THEN** the member reviews a conflict with both versions before any unsafe replacement is shared

### Requirement: Bounded local history
History SHALL be retained on member devices, never on the control plane, for at least 7 days or 500 change sets, whichever is larger. Authorized peers SHALL exchange retained operation history. Pruning SHALL preserve content needed by retained versions, deletions or unresolved recovery, and disclose the oldest recoverable point.

#### Scenario: Pruning
- **WHEN** a device has 600 change sets older than 7 days
- **THEN** the oldest are removed until 500 remain, while content referenced by retained history or pending recovery remains available

#### Scenario: Retained binary version
- **WHEN** an asset is replaced or deleted and its old content is referenced by retained history
- **THEN** restoring that version still retrieves the original bytes after restart

## ADDED Requirements

### Requirement: History persistence failures are recoverable
Failure to save an operation or its recovery data SHALL retain pending information, expose a persistent warning and retry. Acknowledging durable project changes SHALL require their associated history to be durable. Idle grouping and app termination SHALL NOT discard already acknowledged operation history.

#### Scenario: Disk full then recovery
- **WHEN** saving history fails, further edits occur and storage becomes writable again
- **THEN** all pending operations and recovery data are saved once, with their original attribution, and the warning clears only after success

#### Scenario: Termination before idle grouping
- **WHEN** the app terminates after a mutation is acknowledged durable but before the display change set closes
- **THEN** reopening reconstructs the operation history and offers the corresponding recovery or undo

### Requirement: Safe version restore
Restoring a version SHALL include its file tree, source contents, referenced assets and compile settings. It SHALL preserve a durable pre-restore version, validate content availability and detect changes made after the restore preview. Restarting an interrupted restore SHALL expose its state and preserve both versions.

#### Scenario: Missing asset in target version
- **WHEN** a target version references an asset that no authorized source can provide
- **THEN** restore reports the missing asset and preserves the current project instead of silently creating an incomplete replacement

#### Scenario: Co-author edits during restore preview
- **WHEN** a co-author changes a file after a member previews a version restore
- **THEN** the restore detects the changed precondition and asks for an explicit resolution or a refreshed preview before overwriting that contribution

#### Scenario: Restore completion interrupted
- **WHEN** the app stops while applying a multi-file version restore
- **THEN** reopening can resume or reverse that operation from its durable recovery point without losing the pre-restore content

### Requirement: Honest historical identity
History SHALL display the original authenticated account and device where evidence is available and retain attribution across renames, forwarding and restarts. Legacy records without that evidence SHALL remain labelled unverified or unknown; a forwarding peer or a local import SHALL NOT be presented as the original author.

#### Scenario: Legacy snapshot import
- **WHEN** a member imports a project snapshot containing text without original operation metadata
- **THEN** history records who imported it and separately states that original text authorship is unknown

### Requirement: Complete native recovery export across bounded transport
Native full recovery export SHALL preserve all persisted tables in a coherent integrity-checked database snapshot and transfer it in bounded chunks. Its manifest SHALL hash the database and retained live document states. Aggregate history exceeding the single-message transport budget SHALL NOT silently truncate the archive. Missing reads and resource failures SHALL remain explicit without deleting retained data.

#### Scenario: Retained history exceeds one IPC message
- **WHEN** retained snapshots and history exceed the logical message budget
- **THEN** export transfers a coherent database in bounded pieces, includes the live document states and can reopen the exported database without dropping history

#### Scenario: Export interrupted or editor closed
- **WHEN** an export is cancelled or its editor attachment is closed
- **THEN** its temporary handle is released and no other project attachment can read its private snapshot
