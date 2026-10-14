# Spec Delta

## MODIFIED Requirements

### Requirement: Installers built in CI for every desktop platform
Pushing a version tag (`v<major>.<minor>.<patch>`) SHALL build Windows NSIS and MSI installers on a pinned GitHub-hosted Windows runner and attach them to a GitHub Release named after the tag. This release line SHALL distribute Windows installers only.

#### Scenario: Tagging a release
- **WHEN** the maintainer pushes tag `v0.7.3` and the version in the sources is `0.7.3`
- **THEN** a release "HiveTeX v0.7.3" is created with Windows setup and MSI installers attached

#### Scenario: Tag and source version disagree
- **WHEN** a tag `v0.7.4` is pushed while the sources still say `0.7.3`
- **THEN** the release job fails before building, with a message naming both versions

### Requirement: Releases published automatically
A tagged release SHALL stay a draft while the Windows installers are built and checked. It SHALL publish automatically with download links and first-launch notes once the Windows build and packaged checks succeed and both installers, signed update artifacts and update manifest are attached. Otherwise it SHALL stay a draft with an actionable failure. A release with a prerelease suffix SHALL publish as a prerelease and SHALL NOT be offered as a stable update.

#### Scenario: All platforms built
- **WHEN** the Windows build and packaged checks for a tag succeed
- **THEN** the release becomes public and installed apps are offered its signed stable update

#### Scenario: A platform fails to build
- **WHEN** a tagged Windows installer build or packaged check fails
- **THEN** the release stays a draft and a successful retry permits publication

### Requirement: Dry-run builds without a release
The maintainer SHALL be able to build and check Windows installers manually without creating a release or tag. The installers SHALL be downloadable as workflow artifacts. A dry run SHALL work without the updater signing key and then produce installers without update signatures.

#### Scenario: Manual build
- **WHEN** the maintainer starts the Desktop workflow manually
- **THEN** it checks and uploads Windows setup and MSI installers without creating a release or tag

## REMOVED Requirements

### Requirement: macOS builds open without a paid certificate
**Reason**: This release line distributes and validates Windows only.
**Migration**: Non-Windows source remains available; future supported macOS distribution requires a separate release change.

## ADDED Requirements

### Requirement: Complete explicit Windows uninstall
Explicit Windows uninstall SHALL stop the app and its workers and remove program files, per-user local/roaming profiles, caches, managed compilers, offline replicas, credentials and startup. External project folders and separate TeX installations SHALL remain. Upgrades SHALL preserve user state. Cleanup SHALL wait boundedly for stopped processes to release profile handles and report persistent failures.

#### Scenario: Uninstall the setup installation
- **WHEN** the user uninstalls HiveTeX installed using the setup executable
- **THEN** program files, app-owned user data, credentials and login startup are removed

#### Scenario: Uninstall the MSI installation
- **WHEN** the user uninstalls HiveTeX installed using MSI
- **THEN** the same complete per-user cleanup occurs

#### Scenario: Replace an earlier version
- **WHEN** an installer or signed updater removes an earlier version as part of replacement
- **THEN** documents, preferences and credentials survive

#### Scenario: Residue from the former p2platex name
- **WHEN** earlier releases left app.p2platex.desktop data, credentials or login startup
- **THEN** explicit uninstall removes those app-owned residues alongside current HiveTeX state

#### Scenario: WebView releases its files after shutdown
- **WHEN** a stopped app has WebView profile handles that close shortly afterwards
- **THEN** uninstall waits within its deadline and removes the profile; a persistent lock reports failure

#### Scenario: External project folder
- **WHEN** the app previously linked a folder outside its own data directories
- **THEN** uninstall leaves that folder and its content intact

### Requirement: Windows release gates and advisory diagnostics
Required CI SHALL run on Windows and block on static/build checks, deterministic unit/native regressions and packaged startup/installer checks. Browser, desktop UI and timing-sensitive network diagnostics designated as advisory SHALL report failures and retries as warnings with retained logs, without blocking publication or production deployment. Disabled non-Windows test matrices SHALL NOT run automatically.

#### Scenario: Advisory timeout
- **WHEN** a designated advisory diagnostic times out or fails
- **THEN** CI emits a warning and retains its logs while required checks determine release eligibility

#### Scenario: Required regression fails
- **WHEN** a deterministic regression or packaged check fails
- **THEN** CI fails and release publication remains blocked
