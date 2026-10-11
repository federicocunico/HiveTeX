# release-distribution Specification

## Purpose
Lets a maintainer publish installable releases of the desktop app and stand up a free deployment of the control plane,
so that other people can install HiveTeX, point it at that deployment and collaborate.

## Requirements

### Requirement: Installers built in CI for every desktop platform
Pushing a version tag (`v<major>.<minor>.<patch>`) SHALL build the desktop app on GitHub-hosted runners for Windows
(NSIS installer and MSI), macOS (one universal disk image for Apple Silicon and Intel) and Linux (AppImage and Debian
package), and SHALL attach them to a GitHub Release named after the tag. Runner images SHALL be pinned to explicit
versions, so a change of a runner's default image cannot silently break a release.

#### Scenario: Tagging a release
- **WHEN** the maintainer pushes tag `v0.1.0` and the version in the sources is `0.1.0`
- **THEN** a release "HiveTeX v0.1.0" is created with Windows, macOS and Linux installers attached

#### Scenario: Tag and source version disagree
- **WHEN** a tag `v0.2.0` is pushed while the sources still say `0.1.0`
- **THEN** the release job fails before building, with a message naming both versions

### Requirement: Releases published automatically
A tagged release SHALL stay a draft while it is being built, and SHALL be published without a manual step, with
download links and first-launch notes, once all three platform builds have succeeded and every installer and the
update manifest are attached. Otherwise it SHALL stay a draft and the run SHALL say what is missing. A tag with a
pre-release suffix (`v0.3.0-beta.1`) SHALL be published as a pre-release, which installed apps are not offered.

#### Scenario: All platforms built
- **WHEN** the three builds for tag `v0.2.0` succeed
- **THEN** the release "HiveTeX v0.2.0" becomes public with a download table, and installed apps are offered v0.2.0

#### Scenario: A platform fails to build
- **WHEN** the macOS build of a tagged release fails
- **THEN** the release stays a draft, the release run reports that the tag was not built on every platform, and
  re-running the failed build publishes it

### Requirement: Dry-run builds without a release
The maintainer SHALL be able to start the desktop build manually on all three platforms without creating a release. The
installers SHALL then be downloadable as workflow artifacts. A dry run SHALL succeed even when the updater signing key is
not configured; it then produces installers without update signatures.

#### Scenario: Manual build
- **WHEN** the maintainer starts the Desktop workflow manually
- **THEN** the run uploads the Windows, macOS and Linux installers as artifacts and creates no release and no tag

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

### Requirement: macOS builds open without a paid certificate
macOS builds without an Apple Developer certificate SHALL still be code-signed (ad hoc), so that after download macOS
shows its standard "unidentified developer" prompt, with *Open Anyway*, instead of reporting the app as damaged.

#### Scenario: First launch of a downloaded macOS build
- **WHEN** a tester downloads the disk image on Apple Silicon and opens the app
- **THEN** macOS offers *Open Anyway* in Privacy & Security, and the app starts after the tester confirms

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
