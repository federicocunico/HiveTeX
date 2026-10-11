## MODIFIED Requirements

### Requirement: Sign-in and sessions
The system SHALL authenticate users by username (or email) and password and issue a session. Web sessions SHALL use secure, HttpOnly, SameSite cookies; desktop sessions SHALL use a token kept in the OS credential store. Sessions SHALL expire after 30 days of inactivity and SHALL be revocable. The desktop app SHALL NOT require a session to be used: without one it runs in local mode (see local-mode), and signing in later SHALL keep the local projects.

#### Scenario: Correct credentials
- **WHEN** a user submits valid credentials
- **THEN** a session is issued and the user reaches their project list

#### Scenario: Wrong credentials
- **WHEN** a user submits an unknown username or a wrong password
- **THEN** the same generic "invalid credentials" error is returned in both cases

#### Scenario: Sign out everywhere
- **WHEN** a user chooses "sign out of all devices"
- **THEN** every existing session of that user is invalidated

#### Scenario: Desktop without a session
- **WHEN** the desktop app starts with no session and the person chooses Continue without an account
- **THEN** the app opens in local mode, and a Sign in action stays available in the header
