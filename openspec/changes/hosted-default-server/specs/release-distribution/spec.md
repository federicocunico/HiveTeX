# Spec Delta

## MODIFIED Requirements

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
