# Spec Delta

## MODIFIED Requirements

### Requirement: Open a folder as a project
A user SHALL be able to open any folder from the projects page. If the folder carries a project marker for a project
the user can access, that project SHALL open with the folder bound. Otherwise the user SHALL be offered to create a new
project from the folder.

#### Scenario: Folder of a known project
- **WHEN** a member opens a folder whose `.hivetex.json` names a project they belong to
- **THEN** that project opens with the folder bound, and edits made in the folder while the app was closed are merged

#### Scenario: Cloned backup of a project the user has not joined
- **WHEN** a user opens a clone of a project's GitHub backup and is not yet a member
- **THEN** the join form opens pre-filled with the project ID; after joining, the project opens with the folder bound

#### Scenario: Create a project from a folder
- **WHEN** a user opens a folder with LaTeX sources and no marker, and confirms "Create a project from this folder"
- **THEN** a new project is created whose tree equals the folder's (minus ignored build artifacts and tool folders), the
  main file and compiler are detected as for imports, and the folder stays bound

#### Scenario: Folder with a marker for another server or a deleted project
- **WHEN** the marker names a project that does not exist or is not accessible
- **THEN** the user is told so and offered to create a new project from the folder; the folder's files are not modified
  until they confirm

### Requirement: Folder marker
A bound folder SHALL contain a `.hivetex.json` file identifying the project (format version, project ID, project ID
slug), without secrets or document content. The marker SHALL never be synced as a project file. The GitHub backup SHALL
write the same identity so clones are recognised.

#### Scenario: Marker written on bind
- **WHEN** a folder is bound to project `my-paper`
- **THEN** `.hivetex.json` in the folder contains that project's identity, and the file does not appear in the project
  tree

#### Scenario: Backup carries identity
- **WHEN** the GitHub backup pushes a project
- **THEN** the repository's `.hivetex.json` contains the project identity and the backed-up paths
