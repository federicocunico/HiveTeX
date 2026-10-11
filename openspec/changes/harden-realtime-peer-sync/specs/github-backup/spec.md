# Spec Delta

## ADDED Requirements

### Requirement: Complete backup acquisition
A backup SHALL acquire a complete captured project file set before updating a remote branch. Missing text or binary content SHALL fail the backup with an actionable error and retain the previous successful backup. A file unavailable locally SHALL NOT be interpreted as a project deletion. Intentional deletions SHALL still be reflected after successful complete acquisition.

#### Scenario: Missing previously backed-up image
- **WHEN** an image remains in the project file table but cannot be fetched for the next backup
- **THEN** the remote branch and previous image remain unchanged and the backup reports the unavailable file

#### Scenario: Intentional image deletion
- **WHEN** an editor deletes an image from the project and a later complete backup succeeds
- **THEN** that backup removes the image previously managed by HiveTeX

#### Scenario: Text still arriving
- **WHEN** a backup starts before a known text file has arrived
- **THEN** the backup waits or fails explicitly instead of committing an empty replacement

### Requirement: Backup completion acknowledges only captured edits
Successful backup completion SHALL acknowledge only the edits included in its captured file set. Edits made during collection or upload SHALL remain eligible for a later backup, with their contributor attribution retained. Failure SHALL retain all pending changes and SHALL NOT advance the last successful backup time.

#### Scenario: Edit while upload is pending
- **WHEN** a co-author edits after the backup captures its input but before its commit succeeds
- **THEN** the successful backup does not clear that edit from pending work and a subsequent scheduled backup includes it

#### Scenario: Failed upload
- **WHEN** the remote update fails after input capture
- **THEN** all unbacked edits remain pending and the previous successful backup time remains visible
