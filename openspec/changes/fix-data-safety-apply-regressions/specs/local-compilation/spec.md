# Spec Delta

## ADDED Requirements

### Requirement: Compiler resources end with the session
Closing a project SHALL stop its builds and release the compiler workers and processes started for it. Cancelling a
native build SHALL stop the compiler process.

#### Scenario: Reopening projects repeatedly
- **WHEN** a member opens and closes ten projects in the web app
- **THEN** no compiler worker from a closed project remains running

#### Scenario: Cancelled native build
- **WHEN** a running native build is cancelled, for example because its project is closed
- **THEN** its compiler process tree ends and a later build starts without waiting for the old one to finish

### Requirement: Outputs from shared builds are not offered to peers
Generated PDF, log and SyncTeX files that a previous release stored as shared assets SHALL NOT be announced or served
to peers. Assets the project references as inputs SHALL continue to synchronize.

#### Scenario: Project used with shared builds on 0.8.0
- **WHEN** an upgraded member opens a project whose store holds PDFs produced by a former build leader
- **THEN** those generated files are not announced to joining peers, while an uploaded `figure.pdf` used by `\includegraphics` still syncs
