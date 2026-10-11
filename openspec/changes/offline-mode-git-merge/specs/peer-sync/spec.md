## MODIFIED Requirements

### Requirement: Conflict-free merging
Concurrent edits made while devices are linked SHALL merge automatically and deterministically on every device without creating duplicate files, conflict copies or silent overwrites of other members' text. Edits made while a device had no peer linked are merged as described in *Offline editing*.

#### Scenario: Concurrent edits in different paragraphs
- **WHEN** two editors change different paragraphs of the same file at the same time
- **THEN** both changes appear on every device within 1 second on a healthy connection

#### Scenario: Concurrent edits in the same sentence
- **WHEN** two editors type into the same sentence concurrently
- **THEN** both insertions are preserved and all devices converge to identical text

### Requirement: Offline editing
Editors SHALL be able to open and edit any project already present on their device without network access. Changes SHALL be persisted locally on every keystroke batch. Edits a device makes while no peer is linked (no network, *Work offline*, local mode, or nobody else online) SHALL be kept on that device until its next link, and then merged per file, three-way by lines, against the state both sides last shared:
- a file changed on only one side SHALL take that side's version without any prompt;
- changes to different lines of the same file SHALL be merged automatically and the member SHALL be told which files were merged this way;
- changes to the same lines SHALL be conflicts, resolved by the member before that file's merged version is shared;
- a file added on one side SHALL be added; a file deleted on one side and unchanged on the other SHALL be deleted;
- a file deleted on one side and changed on the other, renamed to different paths on both sides, or a binary file changed on both sides SHALL be a conflict with an explicit choice.

Offline edits SHALL never be lost: until resolved, the member's version of a conflicting file stays on their device.

#### Scenario: Offline then reconnect
- **WHEN** an editor edits offline for hours while a co-author edits the same project online, then reconnects
- **THEN** files changed by only one of them are merged on all devices with no user action

#### Scenario: Crash safety
- **WHEN** the app or browser tab is killed during editing
- **THEN** on reopen, all edits made more than 1 second before the kill are present

#### Scenario: Different parts of the same file
- **WHEN** an editor rewrote the introduction of `main.tex` offline while a co-author rewrote its conclusion
- **THEN** both rewrites are in `main.tex` on all devices and the editor sees "Merged your offline changes: main.tex (also changed by others)"

#### Scenario: Same lines
- **WHEN** both rewrote the same paragraph of `main.tex`
- **THEN** `main.tex` is listed as a conflict, the co-author keeps seeing their version, and the merged result is shared only after the editor resolves it

#### Scenario: App closed during an unresolved conflict
- **WHEN** the editor closes the app with a conflict unresolved and opens it again
- **THEN** the conflict is still listed with both versions and nothing was lost

## ADDED Requirements

### Requirement: Resolving merge conflicts
The workspace SHALL show a conflict count while offline work has conflicts, and a resolve view listing each conflicting file. For each conflict in a text file it SHALL show the base, the member's version and the others' version, and offer *keep mine*, *keep theirs*, *keep both* (mine first) and editing the result by hand. For file-level conflicts it SHALL offer the applicable choices: keep the file or delete it, choose a path, choose a binary version. Once every conflict of a file is decided, the file's merged version SHALL be applied as the member's edit and shared; the member SHALL be able to undo it like any edit.

#### Scenario: Keep both
- **WHEN** the member chooses keep both for a conflicting paragraph
- **THEN** the merged file contains their paragraph followed by the others' paragraph, and it is shared with co-authors

#### Scenario: Partly resolved
- **WHEN** a file has two conflicts and the member resolves one
- **THEN** the file is not shared yet and the remaining conflict stays listed

#### Scenario: Viewer
- **WHEN** a viewer's device had offline edits (which viewers cannot make) or the member lost edit rights meanwhile
- **THEN** no merge is offered and the local differences are discarded with a notice, as for read-only enforcement
