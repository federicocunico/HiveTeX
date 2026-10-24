# Spec Delta

## MODIFIED Requirements

### Requirement: Status bar in plain language
The status bar SHALL state in words:
- the sync state: up to date with the time of the last sync, syncing with a percentage, waiting for co-authors, or offline; "All changes synced" SHALL be shown only when no file is missing and no transfer is pending;
- how many people are online, counting co-authors still connecting separately;
- the local compiler used for the current PDF, or why no local compiler is available;
- the scheduling mode and whether a build is waiting, running or blocked;
- the cursor position.

Each item that has an action SHALL open the related panel or menu. The sync item SHALL open a Sync panel listing files with their sync state and who is editing them, with a "Sync now" action. Detailed status SHALL remain available through an accessible summary when it cannot fit in the status bar. Compilation state SHALL NOT imply source synchronization or selection of a peer build leader.

#### Scenario: Offline
- **WHEN** the device loses its connection
- **THEN** the status bar says the user is offline and that edits are kept and will sync on reconnect, and it offers "Work offline" or "Resume" as today

#### Scenario: Who compiled
- **WHEN** a locally compiled PDF is displayed
- **THEN** the status bar identifies the compiler on this machine and does not name a co-author as its build provider

#### Scenario: Syncing
- **WHEN** a co-author is connected and 40% of the known files are received
- **THEN** the status bar says "Syncing 40%" and not "All changes synced"

#### Scenario: Open the Sync panel
- **WHEN** a member activates the sync item
- **THEN** the Sync panel opens with the per-file list, the last sync time and "Sync now"

#### Scenario: PDF behind synced sources
- **WHEN** all sources have synchronized but the local PDF is outdated
- **THEN** the sync status can report completion while the build status separately reports the outdated preview and selected schedule

## ADDED Requirements

### Requirement: Reachable toolbar overflow
Workspace and formatting controls SHALL remain reachable when their pane narrows or interface text is enlarged. Actions that do not fit SHALL move into a labeled keyboard-accessible overflow menu. Recompile and the editor/PDF switch in narrow layout SHALL remain directly reachable. A hidden horizontal scrollbar SHALL NOT be the only way to discover an action or critical status.

#### Scenario: Narrow editor pane
- **WHEN** the member narrows the editor pane until all formatting actions cannot fit
- **THEN** the excess actions appear in a labeled overflow menu and execute on the existing source selection

#### Scenario: Controls return after resize
- **WHEN** the pane widens again
- **THEN** fitting actions return to the toolbar without duplication or unexpected focus loss

#### Scenario: Text enlargement and long names
- **WHEN** the workspace is 1024 px wide with long names and interface text enlarged to 150 percent
- **THEN** the primary actions, critical status and overflow menus remain visible or explicitly reachable without horizontal application overflow

### Requirement: Discoverable compilation controls
The Recompile control SHALL expose the selected schedule and an adjacent options menu for After changes, Periodic and Manual. Periodic SHALL expose the interval. Waiting, running and blocked states SHALL be distinguishable without opening Account settings. Keyboard users SHALL reach the same scheduling and retry actions.

#### Scenario: Change schedule while editing
- **WHEN** a member opens Compile options and selects Periodic with a 30-second interval
- **THEN** the selected setting is visibly confirmed and the current editor selection survives closing the menu

#### Scenario: Recover from a build error
- **WHEN** the latest build fails
- **THEN** the workspace exposes its failure summary and recovery action alongside the preview's outdated state

### Requirement: Consistent authoring hierarchy
The workspace SHALL visually distinguish project actions, file navigation, source editing, PDF controls and status using consistent spacing, type scales and neutral surfaces. Active files, panels and selections SHALL remain identifiable in both themes. HiveTeX's product name and mark SHALL remain intact, and PDF page colors SHALL remain document-controlled.

#### Scenario: Theme change with collaborators
- **WHEN** a member changes between light and dark with a source selection and remote cursors visible
- **THEN** the workspace hierarchy, selected text, active file and collaborator indicators remain readable and the PDF retains its own colors
