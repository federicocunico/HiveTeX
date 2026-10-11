# update-notification Specification

## Purpose
TBD - created by archiving change desktop-update-badge. Update Purpose after archive.

## Requirements

### Requirement: Update check at startup
The desktop app SHALL check the project's GitHub repository for its latest published release each time it starts, in the
background, without delaying or blocking the app. Draft and pre-release versions SHALL be ignored. The web app SHALL NOT
perform this check.

#### Scenario: Start with network
- **WHEN** the desktop app starts and GitHub answers
- **THEN** the latest published release version is compared with the running version

#### Scenario: Offline or GitHub unreachable
- **WHEN** the check fails (no network, rate limit, malformed answer)
- **THEN** nothing is shown, no error is reported to the user, and the app works normally

#### Scenario: Web app
- **WHEN** HiveTeX is used in a browser
- **THEN** no request to GitHub is made for update checking

### Requirement: Update badge
When the latest release is a higher version than the running one, the app SHALL show a badge stating that an update is
available and naming the new version (for example "Version 0.3.0 is available"). The badge SHALL have a **Download**
button that opens the release page in the user's default browser, and a way to dismiss it. When the running version is
equal to or higher than the latest release, no badge SHALL be shown. Versions SHALL be compared numerically
(0.10.0 is newer than 0.9.0).

#### Scenario: Newer release exists
- **WHEN** the running version is 0.2.1 and the latest release is v0.3.0
- **THEN** a badge says version 0.3.0 is available, with a Download button

#### Scenario: Up to date
- **WHEN** the running version is 0.3.0 and the latest release is v0.3.0
- **THEN** no badge is shown

#### Scenario: Download
- **WHEN** the user presses Download
- **THEN** the release page of that version opens in the default browser and the app stays open

#### Scenario: Numeric comparison
- **WHEN** the running version is 0.9.0 and the latest release is v0.10.0
- **THEN** the badge is shown

### Requirement: Dismissed update stays dismissed
Dismissing the badge SHALL hide it on this device for that version, across restarts. A later release with a higher
version SHALL show the badge again.

#### Scenario: Dismiss and restart
- **WHEN** the user dismisses the badge for 0.3.0 and restarts the app while 0.3.0 is still the latest
- **THEN** no badge is shown

#### Scenario: Newer release after dismissing
- **WHEN** the user dismissed 0.3.0 and 0.4.0 is published
- **THEN** the badge announces 0.4.0
