# Spec Delta

## ADDED Requirements

### Requirement: Per-device compiler preference
Each device SHALL let its user choose how documents are compiled:
- **Automatic** (default): the device compiles for the project when it is the best available, unless the user opted
  out of compiling for others; otherwise it shows the result produced by the leader.
- **Use peers:** the device never compiles and is never eligible as leader. It needs no TeX installation and does not
  download an in-browser compiler; it shows the leader's results.
- **This device only:** the device compiles locally after edits settle and shows its own result. It is never eligible as
  leader, and its results are not sent to others.

The preference SHALL apply to every project on the device, persist across restarts, and take effect without reopening
the project. The workspace SHALL show the active preference and which device produced the visible PDF.

#### Scenario: No LaTeX installed
- **WHEN** a member without a TeX installation chooses *Use peers* and a co-author's device can compile
- **THEN** the member sees the PDFs compiled by that device, and nothing is compiled or downloaded on their own device

#### Scenario: No peer can compile
- **WHEN** a member uses *Use peers* and no connected device can compile
- **THEN** the workspace says that no peer can compile right now and points to the other preferences

#### Scenario: This device only
- **WHEN** a member with TeX installed chooses *This device only* and edits the document
- **THEN** their device compiles and shows its own PDF, and co-authors' leader election and results are unaffected

#### Scenario: Switching takes effect immediately
- **WHEN** the current leader's user switches to *Use peers*
- **THEN** that device stops being leader and the next-best eligible device takes over without anyone reopening the
  project
