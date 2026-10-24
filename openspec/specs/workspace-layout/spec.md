# workspace-layout Specification

## Purpose
Defines how the project workspace is organized: header, activity rail with side panels, editor and PDF panes, status
bar, Share dialog and first-run tour. The aim is that a first-time writer finds the essentials and an experienced user
can reshape the screen.

## Requirements

### Requirement: Workspace header
The workspace header SHALL show:
- a way back to all projects;
- the project name, its project ID and the user's role;
- the avatars of collaborators currently online;
- a "Share" action;
- a primary "Recompile" action with a menu for compile options;
- a PDF download action;
- a menu holding the remaining project actions.

The header SHALL hold no more than four labeled or icon actions besides that menu.

#### Scenario: Header contents for an owner
- **WHEN** an owner opens a project
- **THEN** the header shows the project name, its ID, the role "Owner", the online avatars, Share, Recompile, Download
  PDF and More actions

#### Scenario: Viewer header
- **WHEN** a viewer opens a project
- **THEN** the header shows the role "Viewer", Recompile and Download PDF stay available, and Share opens in read-only
  form showing the project ID only

### Requirement: Activity rail and side panels
The workspace SHALL have a vertical activity rail that switches one side panel between these panels:
- Files;
- Outline;
- Search;
- Changes;
- History;
- People;
- GitHub backup.

Activating the active panel's rail button again SHALL collapse the side panel. Each rail button SHALL have an
accessible name and a tooltip. Changes SHALL show a count of change sets the user has not seen yet.

#### Scenario: Switch panel
- **WHEN** a user activates the Outline button on the rail
- **THEN** the side panel shows the document outline and the Outline button is marked as active

#### Scenario: Collapse panel
- **WHEN** the Files panel is open and the user activates the Files button again
- **THEN** the side panel collapses and the editor widens to use the space

#### Scenario: Unseen changes
- **WHEN** co-authors' change sets arrive while the Changes panel is closed
- **THEN** the Changes rail button shows how many arrived, and the count clears when the panel is opened

### Requirement: Resizable editor and PDF panes
The editor and PDF panes SHALL be separated by a splitter that can be dragged with a pointer and moved with the arrow
keys when focused. The side panel width SHALL be adjustable the same way. Either pane SHALL be collapsible.

#### Scenario: Keyboard resize
- **WHEN** a keyboard user focuses the splitter and presses Left Arrow
- **THEN** the editor pane narrows by a fixed step and the splitter announces its new position

#### Scenario: Collapse the PDF
- **WHEN** a user collapses the PDF pane
- **THEN** the editor takes the full width, and an action to show the PDF again stays visible

### Requirement: Narrow-screen layout
Below 1100 px wide, the workspace SHALL show either the editor or the PDF, with a visible toggle between them. The side
panel SHALL overlay the editor instead of pushing it.

#### Scenario: 1024 px window
- **WHEN** the workspace is shown at 1024 px wide
- **THEN** one of editor or PDF is visible, the Editor/PDF toggle is visible, and nothing overflows horizontally

### Requirement: Focus mode
The workspace SHALL offer a focus mode that hides the rail, the side panel, the formatting toolbar and the status bar,
and keeps the editor and, if open, the PDF. Leaving focus mode SHALL restore the previous layout.

#### Scenario: Enter and leave focus mode
- **WHEN** a user turns focus mode on and then off
- **THEN** only the editor and PDF are shown while it is on, and the previous panels and toolbar return when it is
  off

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
- **THEN** the status bar says the user is offline and that edits are kept and will sync on reconnect, and it offers
  "Work offline" or "Resume" as today

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

### Requirement: PDF pane status
The PDF pane toolbar SHALL show whether the PDF is up to date, and if not, how many edits are newer than it. It SHALL
also show the zoom level and the page position.

#### Scenario: Outdated PDF
- **WHEN** two edits are newer than the displayed PDF
- **THEN** the PDF toolbar shows an "Outdated" indicator that mentions the pending edits until a newer PDF arrives

### Requirement: Share dialog
The workspace SHALL provide a Share dialog. It SHALL show the project ID with an action that copies an invitation
text containing the ID and joining instructions but never the password. For owners it SHALL also offer:
- the password setting;
- the default role for new members;
- the member list with role changes and removal.

This uses the same rules as project settings.

#### Scenario: Copy invitation
- **WHEN** an owner activates "Copy invitation"
- **THEN** the clipboard holds text naming the project ID and how to join, and a confirmation says it was copied

#### Scenario: Change a role from Share
- **WHEN** an owner changes a member's role to Viewer in the Share dialog
- **THEN** the change takes effect exactly as when made in project settings

#### Scenario: Editor opens Share
- **WHEN** an editor opens the Share dialog
- **THEN** the dialog shows the project ID and "Copy invitation", and no password, role or member controls

### Requirement: First-run tour
The first time a user opens any project, the workspace SHALL offer a short tour of at most five steps covering the
editor, the rail, compiling and sharing. The tour SHALL be skippable at any step, SHALL NOT appear again on that
device once finished or skipped, and SHALL be available again from Help.

#### Scenario: Skip the tour
- **WHEN** a new user selects "Skip tour" on the first step
- **THEN** the tour closes, and it does not appear when they open another project

#### Scenario: Replay
- **WHEN** a user chooses "Take the tour" from Help
- **THEN** the tour starts from its first step

### Requirement: Icons with names
Every icon-only control in the app SHALL have an accessible name and a visible tooltip on hover and keyboard focus.
Emoji SHALL NOT be used as interface icons.

#### Scenario: Rail tooltip
- **WHEN** a keyboard user focuses the History rail button
- **THEN** a tooltip reading "History" appears and screen readers announce "History"

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
