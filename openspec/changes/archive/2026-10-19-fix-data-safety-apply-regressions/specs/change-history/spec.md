# Spec Delta

## ADDED Requirements

### Requirement: Remote contributions stay out of local change sets
A local change set SHALL contain only edits from its own origin and device. When a co-author's edit is applied to a
document, any open local change set for that document SHALL be closed first, so undoing it cannot remove the
co-author's edit.

#### Scenario: Interleaved typing
- **WHEN** Alice types "A", Bob's "B" arrives, then Alice types "C" in the same paragraph within the grouping window
- **THEN** Alice's Changes list shows separate change sets for her edits and one for Bob's, and undoing Alice's latest change set removes "C" and leaves "B"

### Requirement: Interrupted undo and restore are resumable
An undo or restore that stops after its checkpoint SHALL leave a state the member can resume or abandon from the
history view. A precondition that fails before any mutation SHALL NOT leave a pending checkpoint. A retry SHALL NOT
fail only because an earlier attempt was interrupted.

#### Scenario: Precondition fails between preview and restore
- **WHEN** a co-author edits the project after a member previewed a version and then clicks restore
- **THEN** the restore is refused with the reason, no pending restore remains in History, and a new preview can be restored

#### Scenario: Undo interrupted mid-way
- **WHEN** an undo of a multi-file change set fails after inverting some files
- **THEN** History shows the undo as interrupted with the files already inverted, and the member can complete or reverse it

### Requirement: Baselines are not reported as edits
Loading, bootstrapping or first receiving a document SHALL NOT produce change sets after a restart. History SHALL NOT
show an edit of the whole file by an unknown author for content that was only loaded.

#### Scenario: Restart after first sync
- **WHEN** a new member receives a project, closes the app before any edit, and reopens it
- **THEN** the Changes view shows no change sets attributed to an unknown original author for the received files

### Requirement: History views scale with retained history
Opening History, Recovery or Changes, and receiving a co-author's edit, SHALL NOT require reading every retained
history record. Retained history SHALL NOT make synchronization, quarantine or recovery capture fail because a listing
exceeds a transport limit.

#### Scenario: Large retained history
- **WHEN** a project holds 500,000 retained operation records and the Recovery panel is open while a co-author types
- **THEN** each remote edit is applied and the panel stays responsive without listing every record per edit

### Requirement: Recovery export within bounded memory
The full recovery export SHALL hold at most a bounded part of the store in memory beyond the archive being written. An
export that would exceed the archive format's limits SHALL be refused with an explicit message before the work starts.

#### Scenario: Large store export on desktop
- **WHEN** a member exports the full recovery archive of a 1 GiB store
- **THEN** peak memory stays below the store size plus a bounded overhead, and the archive verifies against its manifest

#### Scenario: Archive beyond format limit
- **WHEN** the export would produce an archive larger than the format supports
- **THEN** the export is refused with a message before writing anything, and the store is unchanged

### Requirement: Blocked store upgrade is reported
When a local store upgrade cannot proceed because another tab or window still holds the previous version open, the app
SHALL tell the member which action unblocks it. The app SHALL NOT wait without feedback. An open connection SHALL close
when a newer version requests the upgrade.

#### Scenario: Old tab still open
- **WHEN** a member opens the upgraded web app while a tab of the same build is open on the same project
- **THEN** the older tab closes its store connection or the new tab shows that the other tab must be closed, and neither waits silently

### Requirement: Re-upgrade after rollback keeps later work
On desktop, after a rollback to the previous release and further work, upgrading again SHALL NOT ignore content written
to the legacy store in the meantime. It SHALL either merge that content or tell the member which store holds it.

#### Scenario: Upgrade, rollback, offline work, upgrade
- **WHEN** a member upgrades, rolls back to 0.8.0, edits offline, and upgrades again
- **THEN** the edits made on 0.8.0 are present after the second upgrade, or a visible notice names the store that contains them and how to export it
