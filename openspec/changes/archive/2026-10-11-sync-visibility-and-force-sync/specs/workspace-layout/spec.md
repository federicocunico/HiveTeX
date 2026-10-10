# Spec Delta

## MODIFIED Requirements

### Requirement: Status bar in plain language
The status bar SHALL state in words:
- the sync state: up to date with the time of the last sync, syncing with a percentage, waiting for co-authors, or
  offline; "All changes synced" SHALL be shown only when no file is missing and no transfer is pending;
- how many people are online, counting co-authors still connecting separately;
- which device compiled the current PDF, and why it was chosen;
- the compile mode;
- the cursor position.

Each item that has an action SHALL open the related panel or menu. The sync item SHALL open a Sync panel listing
files with their sync state and who is editing them, with a "Sync now" action.

#### Scenario: Offline
- **WHEN** the device loses its connection
- **THEN** the status bar says the user is offline and that edits are kept and will sync on reconnect, and it offers
  "Work offline" or "Resume" as today

#### Scenario: Who compiled
- **WHEN** a PDF compiled by another device is displayed
- **THEN** the status bar names that device and says it was chosen as the best available

#### Scenario: Syncing
- **WHEN** a co-author is connected and 40% of the known files are received
- **THEN** the status bar says "Syncing 40%" and not "All changes synced"

#### Scenario: Open the Sync panel
- **WHEN** a member activates the sync item
- **THEN** the Sync panel opens with the per-file list, the last sync time and "Sync now"
