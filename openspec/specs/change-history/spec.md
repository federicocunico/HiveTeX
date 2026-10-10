# change-history Specification

## Purpose
Makes every change to a project visible and reversible, especially changes made outside the app by AI tools or editors on the project's folder, without introducing locks or a manual staging step.

## Requirements

### Requirement: Change sets
Each device SHALL record changes to the project as change sets: consecutive edits from the same source grouped until the source has been idle for a few seconds. A change set SHALL record its source (this device's folder, this device's editor, or a co-author by name), its time, and the files it changed.

#### Scenario: AI tool session
- **WHEN** Claude Code edits three files in the bound folder within a few seconds
- **THEN** one change set "Folder on this device" lists those three files with the time

#### Scenario: Co-author edits
- **WHEN** co-author Ada edits `intro.tex`
- **THEN** a change set attributed to Ada appears on every other device

### Requirement: Changes view
The workspace SHALL offer a Changes view listing recent change sets, newest first, with a per-file diff of what each change set did.

#### Scenario: Review what the AI did
- **WHEN** a member opens a change set from the folder
- **THEN** each changed file shows its additions and removals; created, deleted and renamed files are labelled as such

### Requirement: Undo a change set
A member with edit rights SHALL be able to undo a change set. The undo SHALL be applied as a normal collaborative edit that reverses only that change set, preserving later edits that do not overlap, and SHALL itself appear as a change set.

#### Scenario: Undo an AI edit after others typed
- **WHEN** a member undoes the folder change set that rewrote a paragraph, after Ada edited another paragraph of the same file
- **THEN** the rewritten paragraph returns to its previous text, Ada's edit remains, and every device converges

#### Scenario: Viewer
- **WHEN** a viewer opens the Changes view
- **THEN** they can review change sets but no undo action is offered

### Requirement: No locks, no staging
Edits from the folder SHALL sync automatically, like edits typed in the app. Files SHALL never be locked, and no confirmation SHALL be required before a change reaches co-authors.

#### Scenario: Continuous sync
- **WHEN** an AI tool saves a file
- **THEN** co-authors receive the change without any action in the app

### Requirement: Bounded local history
Change sets SHALL be stored on the device only (not on the control plane), keeping at least the last 7 days or 500 change sets, whichever is larger. Older entries SHALL be pruned automatically.

#### Scenario: Pruning
- **WHEN** a device has 600 change sets older than 7 days
- **THEN** the oldest are removed until 500 remain
