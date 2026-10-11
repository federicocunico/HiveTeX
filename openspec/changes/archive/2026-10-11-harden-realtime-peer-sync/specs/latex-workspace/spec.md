# Spec Delta

## ADDED Requirements

### Requirement: Editor follows the current selection
The editor SHALL display and edit only the currently selected file in the active project. Completion of an earlier file load or document replacement SHALL NOT restore an obsolete binding. Closing the editor SHALL prevent pending loads from recreating it. Rebinding SHALL release the previous editor and undo resources.

#### Scenario: Rapid file switching
- **WHEN** the member selects file A and then file B while A loads slowly
- **THEN** B remains the only active editor even if A finishes last, and typing changes B only

#### Scenario: Close during loading
- **WHEN** a project closes while its editor awaits a file
- **THEN** completion does not recreate an editor or mutate the closed project

### Requirement: Complete source exports
Source export SHALL capture a complete consistent file set, distinguishing unavailable content from empty content. If required content cannot be obtained, export SHALL report the missing files without presenting an incomplete archive as the full project. A complete local project SHALL remain exportable offline.

#### Scenario: Export during initial transfer
- **WHEN** a member requests source export after the file list arrives but before a text body arrives
- **THEN** export waits for that body or reports it unavailable instead of substituting an empty file

### Requirement: Folder reconciliation preserves concurrent work
Folder reconciliation SHALL retain a common baseline whenever disk and project contents agree, including immediately after binding. Concurrent disk and peer edits SHALL be merged from that baseline without silently overwriting either side. Overlapping changes that cannot be merged safely SHALL retain both versions and require resolution. Unavailable project content SHALL NOT overwrite disk files.

#### Scenario: Matching folder followed by concurrent edits
- **WHEN** disk and project match at bind time, a peer then edits the file, and a local tool edits the previous disk version
- **THEN** non-overlapping edits from both sides survive in the project and on disk

#### Scenario: Partial project at bind time
- **WHEN** the project knows a file's name but has not received its content and the folder contains that file
- **THEN** the folder content is preserved until reconciliation can distinguish missing content from an intentional empty file

#### Scenario: Overlap after reopening
- **WHEN** both the saved project and the folder changed the same lines while the app was closed
- **THEN** both versions remain recoverable and the member resolves the overlap before a destructive replacement

### Requirement: Viewer-safe initial folder binding
Binding or reopening a viewer's folder SHALL NOT produce project content mutations, including initial import or reconciliation. Existing local differences SHALL be treated using the same read-only policy as subsequent external edits, with a notice when restored from available project content.

#### Scenario: Viewer binds a different folder copy
- **WHEN** a viewer binds a folder whose existing text differs from the project
- **THEN** the project remains unchanged and the viewer is informed of the read-only reconciliation outcome
