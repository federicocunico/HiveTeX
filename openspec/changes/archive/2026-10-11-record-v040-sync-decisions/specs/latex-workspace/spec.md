## MODIFIED Requirements

### Requirement: Viewer-safe initial folder binding
Binding or reopening a viewer's folder SHALL NOT produce project content mutations, including initial import or reconciliation. A folder file that differs from available project content SHALL be restored from the project with a notice. A folder file that is not part of the project SHALL be left on disk, unshared, with a notice, because the file list may still be incomplete. A file whose project content has not arrived SHALL be compared once it is complete. Later external changes follow the read-only policy.

#### Scenario: Viewer binds a different folder copy
- **WHEN** a viewer binds a folder whose existing text differs from the project
- **THEN** the project remains unchanged and the viewer is informed of the read-only reconciliation outcome

#### Scenario: Viewer folder has a file the project does not
- **WHEN** a viewer binds a folder containing `extra.tex`, which is not in the project
- **THEN** `extra.tex` stays on disk unchanged, is not shared, and the viewer is told it is not part of the project

#### Scenario: New file after binding
- **WHEN** a program creates a new file in a viewer's bound folder after binding
- **THEN** the file is removed and the viewer is told the change was reverted
