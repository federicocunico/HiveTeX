# Spec Delta

## MODIFIED Requirements

### Requirement: Import entry points
Import SHALL be available when creating a project and, for editors, from within an existing project. The projects home page SHALL expose an **Import ZIP…** action alongside its project actions, including in empty and local-mode views. Selecting a ZIP SHALL start new-project creation with that source selected. Viewers SHALL NOT be offered import within a viewed project.

#### Scenario: Create from archive
- **WHEN** a user creates a project and selects an archive or folder on the creation form
- **THEN** the new project opens already containing the imported files

#### Scenario: Home ZIP action
- **WHEN** a user selects Import ZIP on the projects home page and chooses a ZIP
- **THEN** project creation opens with that ZIP selected, the existing preview and main-file choice are used, and no template files are added

#### Scenario: Empty local home
- **WHEN** a user opens the projects home in local mode with no projects
- **THEN** Import ZIP is visible and can create a project without signing in or contacting the control plane

#### Scenario: Cancel ZIP picker
- **WHEN** a user cancels the home ZIP picker
- **THEN** no project is created and existing projects remain unchanged

#### Scenario: Import into existing project
- **WHEN** an editor chooses "Import…" in an open project and selects an archive
- **THEN** the import preview opens for that project

#### Scenario: Viewer
- **WHEN** a viewer opens a project
- **THEN** no import or upload action is shown and dropping files on the tree has no effect

## ADDED Requirements

### Requirement: Locally complete project initialization
A project created from local sources SHALL retain a complete local file list, imported text, assets, and selected build settings without peer confirmation. Successful initialization SHALL be saved durably and remain usable after project reopening or application restart. A failed save SHALL expose a local storage error and SHALL NOT claim durable import success.

#### Scenario: New ZIP with no peers
- **WHEN** a user finishes creating a project from a valid ZIP while no co-author is connected
- **THEN** the sources and binary assets are available for editing, export, and local build input capture without asking a peer to confirm the file list

#### Scenario: New project from an existing folder
- **WHEN** a user opens a local folder and creates a new project from it
- **THEN** the initialized file list and imported content are locally complete without a co-author joining

#### Scenario: Reopen after initialization
- **WHEN** the user restarts the app after successful initialization from a ZIP or folder
- **THEN** the project opens from its local storage with the same sources, assets, main file, and compiler choice without peer confirmation

#### Scenario: Later co-author
- **WHEN** an authorized co-author joins a project initialized from local sources
- **THEN** the initializing device can supply its complete source tree and assets through normal peer synchronization without a prior source provider

#### Scenario: Joined project is still incomplete
- **WHEN** a user joins a project whose remote sources have never reached this device and adds one local file
- **THEN** that addition does not declare the entire project or unseen remote files complete
