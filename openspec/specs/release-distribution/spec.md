# release-distribution Specification

## Purpose
Lets a maintainer publish installable releases of the desktop app and stand up a free deployment of the control plane,
so that other people can install HiveTeX, point it at that deployment and collaborate.

## Requirements

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

### Requirement: Signed automatic updates
Release builds SHALL sign their update artifacts with the project's updater key and publish an update manifest with the
release. Installed apps SHALL check the repository's latest published release for updates and SHALL only install updates
whose signature matches the public key built into the app. A release build without the signing key SHALL fail, rather
than publish unsigned updates.

#### Scenario: Missing signing key on a tag
- **WHEN** a version tag is pushed and the signing secret is not configured
- **THEN** the release job fails with a message saying which secret to set

#### Scenario: Update from the real repository
- **WHEN** a published release newer than the installed version exists in the project's GitHub repository
- **THEN** the app offers it, and the update source is that repository's latest-release manifest

### Requirement: Choosing the server before signing in (desktop)
The desktop app SHALL ship with `https://hivetex.vercel.app` as its default server. A build MAY replace that default (for
forks and on-premise deployments). The sign-in and registration screens SHALL show which server the app uses and SHALL
let the user change it before signing in; Account settings SHALL offer the same change. A user-chosen value SHALL be
validated as an `https://` origin (`http://localhost` allowed for development), remembered on the device, and SHALL take
precedence over the default. The user SHALL be able to return to the default server. The web app SHALL always use its
own origin and SHALL NOT show this setting.

#### Scenario: Installer without a default server
- **WHEN** a tester opens a desktop build made without a build-specific server
- **THEN** the app uses `https://hivetex.vercel.app`, and the sign-in screen shows it as the server

#### Scenario: Invalid server address
- **WHEN** the tester enters `ftp://example.com` or a non-URL
- **THEN** the address is rejected with an explanation and the previous server stays in use

#### Scenario: On-premise server
- **WHEN** a user sets `https://latex.example.org` as the server
- **THEN** registration, sign-in, signaling and project data go to that server on this device, until the user changes it
  again

#### Scenario: Back to the default
- **WHEN** a user who set another server chooses "Use the default server"
- **THEN** the app uses the build's default server again, and the custom address is forgotten

### Requirement: Documented setup for a test deployment
The repository SHALL provide one command (`make setup`) that performs the first deployment of a test release
end to end, and SHALL be safe to re-run. It SHALL:
- check the required tools and logins;
- link the hosting project and provision the database and Redis services when missing;
- store the server secrets and settings;
- deploy;
- verify the deployment answers its health check;
- configure the GitHub secret and variable used by desktop releases.

It SHALL ask only for values that cannot be generated (mail account and app password, the first admin's username,
optional TURN credentials). It SHALL accept these from the environment or from a git-ignored local file, so it can run
without prompts. Secrets SHALL never be written to tracked files or printed. The README SHALL describe this command,
the manual steps as a fallback, tagging a release, and installing and testing on each platform.

#### Scenario: Following the guide
- **WHEN** a maintainer with the listed accounts follows the README (`make setup`, then `make release`)
- **THEN** they end with a deployed web app, a published release with installers, and testers who can register and open a
  shared project

#### Scenario: First setup
- **WHEN** a maintainer logged in to Vercel and GitHub runs `make setup` and answers the prompts
- **THEN** the web app is deployed with its database schema, `/api/health` answers, and the repository has the updater
  key secret and the server URL variable

#### Scenario: Re-running setup
- **WHEN** `make setup` runs again on an already configured project
- **THEN** existing secrets (ticket keys, mail password) are kept, unless rotation is explicitly requested, and the run
  ends with a fresh deployment

#### Scenario: Unattended run
- **WHEN** all non-generated values are present in the environment or the local setup file
- **THEN** `make setup` completes without asking anything

#### Scenario: Generating secrets
- **WHEN** the maintainer runs `make secrets`
- **THEN** missing ticket-signing keys are generated and stored for production and preview, existing ones are kept
  unless `ROTATE=1`, the updater key is stored as a GitHub secret, and no secret value is printed

### Requirement: Schema migrations during deployment
Each deployment of the control plane SHALL apply pending database migrations before the new version serves requests,
using the deployment's own database credentials. A failed migration SHALL fail the deployment.

#### Scenario: New migration
- **WHEN** a commit adds a migration and is deployed
- **THEN** the deployment applies it during the build, and the build fails if the migration fails

### Requirement: First administrator bootstrap
When the server setting `BOOTSTRAP_ADMIN` names a username and no platform admin exists, the account with that
username SHALL become a platform admin when it registers or signs in. Once any admin exists, the setting SHALL have no
effect.

#### Scenario: Designated user registers first
- **WHEN** `BOOTSTRAP_ADMIN=alice` and no admin exists, and alice registers
- **THEN** alice is a platform admin

#### Scenario: An admin already exists
- **WHEN** an admin exists and the user named by `BOOTSTRAP_ADMIN` signs in
- **THEN** that user's role is unchanged

### Requirement: Public origin from the hosting platform
When `APP_ORIGIN` is not set, a production deployment SHALL use the hosting platform's stable production domain as its
public origin (for links in emails and cookie security), not the address of the individual deployment.

#### Scenario: No APP_ORIGIN on a production deployment
- **WHEN** the server runs in production on the hosting platform without `APP_ORIGIN`
- **THEN** reset and verification links use `https://<production domain>`

### Requirement: Installing a new version replaces the old one
Running a HiveTeX Windows installer SHALL remove any previous HiveTeX installation on the machine, whichever installer
type (setup executable or MSI) created it, before installing the new version, so that exactly one HiveTeX remains
installed and listed in Apps. The user's projects, settings and stored credentials SHALL be kept. The replacement SHALL
not require the user to uninstall manually.

#### Scenario: Upgrade over the same installer type
- **WHEN** version 0.2.1 was installed with the setup executable and the user runs the 0.3.0 setup
- **THEN** only 0.3.0 is installed afterwards and its files replace the old ones

#### Scenario: Upgrade across installer types
- **WHEN** version 0.2.1 was installed from the MSI and the user runs the 0.3.0 setup executable
- **THEN** the MSI installation is removed and only 0.3.0 is listed in Apps

#### Scenario: User data survives
- **WHEN** an upgrade replaces the old installation
- **THEN** local projects, preferences, the chosen server and the signed-in session are still present

### Requirement: Production deployment after stable publication
Publishing a stable HiveTeX release SHALL automatically initiate deployment of the web app and control plane to Vercel production. This SHALL work for releases published by the existing automated Release workflow and releases published manually. Drafts, prereleases and failed installer publication SHALL NOT initiate production deployment. Existing successful-CI deployments from master SHALL remain supported.

#### Scenario: Automated release publication
- **WHEN** the Release workflow publishes a stable version after the required installer assets are available
- **THEN** production deployment is initiated without maintainer action even though publication uses the built-in automation token

#### Scenario: Manual stable publication
- **WHEN** a maintainer publishes a stable version release manually
- **THEN** production deployment for that release is initiated under the same checks

#### Scenario: Draft or prerelease
- **WHEN** a release remains a draft, has a prerelease suffix, or is marked as a prerelease
- **THEN** it does not trigger a production deployment

#### Scenario: Publication failed
- **WHEN** installer checks or release publication fail
- **THEN** no release-driven production deployment is initiated and the release run reports the failure

### Requirement: Checked release source
A release-driven production deployment SHALL use the immutable commit resolved from its validated version tag and SHALL require successful CI for that exact commit. A missing or failing CI result SHALL block production changes with an actionable failure. Deployment SHALL NOT substitute a branch tip or the workflow runner's default commit for the release source.

#### Scenario: Master advances after tagging
- **WHEN** tag `v1.2.3` identifies commit A and master advances to B
- **THEN** a permitted release deploy uses A rather than silently deploying B

#### Scenario: CI missing or failed
- **WHEN** the release's exact source commit has no successful CI result
- **THEN** deployment waits for an applicable running check up to a bounded timeout or fails with a clear recovery instruction, and production remains unchanged

#### Scenario: Tag mismatch on retry
- **WHEN** a retry finds that the release tag no longer resolves to the recorded source commit
- **THEN** it refuses deployment and reports the mismatch

### Requirement: Ordered and repeatable production changes
All automated production deploys SHALL be serialized and SHALL recheck eligibility before changing production. A release deploy SHALL not replace a production commit that is a known newer descendant, and an older stable version SHALL not replace a newer published version. Duplicate notifications and retries for the same tag and commit SHALL be safe. A skipped stale deployment SHALL report its reason.

#### Scenario: Newer master is already deployed
- **WHEN** a release's commit is an ancestor of the current successful production commit
- **THEN** the release deploy is skipped with a message that production already contains newer code

#### Scenario: Repeat deployment notification
- **WHEN** the same release is delivered twice after its source is successfully deployed
- **THEN** the second run verifies or safely skips the existing result without rolling production back

#### Scenario: Old release published late
- **WHEN** a lower stable version is published after a newer stable release
- **THEN** it does not replace the newer production version

### Requirement: Verifiable production outcome and recovery
A production deploy SHALL report the source commit, release tag when applicable, deployment URL and terminal outcome. It SHALL verify the newly created deployment and the production target rather than treating a healthy previous deployment as success. Deploy or migration failures SHALL fail the run with useful logs. Maintainers SHALL be able to retry a failed release deployment without rebuilding or republishing installers.

#### Scenario: Release and production succeed
- **WHEN** publication and Vercel deployment finish successfully
- **THEN** the deployment summary identifies the release, source commit, Vercel deployment and verified production target

#### Scenario: Vercel upload or build fails
- **WHEN** a release is published but production deployment fails after bounded retries
- **THEN** the installers remain published, the deploy run fails visibly, and its summary explains how to retry that release

#### Scenario: Previous deployment remains healthy
- **WHEN** the former production endpoint is healthy but the new deployment fails or the alias still targets the former deployment
- **THEN** the run fails rather than reporting the release successfully deployed

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
