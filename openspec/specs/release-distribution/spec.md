# release-distribution Specification

## Purpose
Lets a maintainer publish installable releases of the desktop app and stand up a free deployment of the control plane,
so that other people can install p2platex, point it at that deployment and collaborate.

## Requirements

### Requirement: Installers built in CI for every desktop platform
Pushing a version tag (`v<major>.<minor>.<patch>`) SHALL build the desktop app on GitHub-hosted runners for Windows
(NSIS installer and MSI), macOS (one universal disk image for Apple Silicon and Intel) and Linux (AppImage and Debian
package), and SHALL attach them to a draft GitHub Release named after the tag. Runner images SHALL be pinned to explicit
versions, so a change of a runner's default image cannot silently break a release.

#### Scenario: Tagging a release
- **WHEN** the maintainer pushes tag `v0.1.0` and the version in the sources is `0.1.0`
- **THEN** a draft release "p2platex v0.1.0" appears with Windows, macOS and Linux installers attached

#### Scenario: Tag and source version disagree
- **WHEN** a tag `v0.2.0` is pushed while the sources still say `0.1.0`
- **THEN** the release job fails before building, with a message naming both versions

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
The desktop app's sign-in and registration screens SHALL show which server the app uses and SHALL let the user change
it before signing in. The value SHALL be validated as an `https://` origin (`http://localhost` allowed for development)
and remembered on the device. An installer built with a default server SHALL use it until the user changes it. The web
app SHALL always use its own origin and SHALL NOT show this setting.

#### Scenario: Installer without a default server
- **WHEN** a tester opens a desktop build that has no built-in server
- **THEN** the sign-in screen asks for the server address, and after the tester enters the deployment URL, registration
  and sign-in go to that server

#### Scenario: Invalid server address
- **WHEN** the tester enters `ftp://example.com` or a non-URL
- **THEN** the address is rejected with an explanation and the previous server stays in use

### Requirement: Documented setup for a test deployment
The README SHALL contain a short, ordered setup guide for a first test release. Each step SHALL have at most a few
sentences and the exact commands or variables, and the guide SHALL cover:
- creating the free services (Vercel, Neon, Upstash, a Gmail App Password; Cloudflare TURN optional);
- generating and setting the server secrets, deploying and running migrations;
- creating the first admin account;
- setting the GitHub secrets and variables for desktop releases;
- tagging a release;
- installing on each platform, and how to test together.

The repository SHALL include a script that generates the ticket-signing key pair and prints the commands that store
the values in Vercel and GitHub, without writing secrets into tracked files.

#### Scenario: Following the guide
- **WHEN** a maintainer with the listed accounts follows the README steps in order
- **THEN** they end with a deployed web app, a draft release with installers, and testers who can register and open a
  shared project

#### Scenario: Generating secrets
- **WHEN** the maintainer runs the secrets script
- **THEN** it prints a fresh `TICKET_SIGNING_JWK`, the matching `TICKET_PUBLIC_JWKS` and the `vercel env add` / `gh secret
  set` commands, and creates or modifies no tracked file
