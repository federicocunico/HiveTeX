# Spec Delta

## ADDED Requirements

### Requirement: Automated desktop UI tests
The repository SHALL provide end-to-end tests that drive the real desktop app through WebDriver, covering linking a folder, opening a folder of a known project, creating a project from a folder and importing a folder, runnable locally (`make desktop-e2e`) and in CI on Linux and Windows. Native dialogs SHALL be replaced in these tests by a test-only override that is not present in release builds.

#### Scenario: CI run
- **WHEN** the desktop workflow runs on a pushed commit
- **THEN** the desktop UI tests run on Linux and Windows and the workflow fails if any of them fails

#### Scenario: Release build
- **WHEN** the release installers are built
- **THEN** they do not contain the test-only folder picker override

### Requirement: Scheduled stack verification
CI SHALL run the end-to-end suite against the containerized local stack on a schedule (at least nightly) and on demand.

#### Scenario: Nightly
- **WHEN** the nightly schedule triggers
- **THEN** the stack starts in CI, `make test-stack` runs, and the job reports failure if it fails

### Requirement: Supported CI actions runtime
CI workflows SHALL use action versions that run on a supported Node.js runtime, so runs produce no runtime-deprecation warnings.

#### Scenario: Workflow annotations
- **WHEN** CI runs
- **THEN** no "Node.js 20 is deprecated" annotation is produced
