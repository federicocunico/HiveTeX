# Spec Delta

## ADDED Requirements

### Requirement: Remembered desktop sign-in
Successful desktop sign-in and registration SHALL remember the session on this computer by default using the OS credential store. Persistence SHALL finish before sign-in is reported as remembered. On restart, the app SHALL restore a valid saved session before deciding whether to show sign-in. Passwords SHALL NOT be saved on the device. Existing expiry and revocation rules SHALL continue to apply.

#### Scenario: Reopen after signing in
- **WHEN** a user signs in successfully, closes HiveTeX and reopens it on the same computer with a valid saved session
- **THEN** the app opens their project list without asking for credentials

#### Scenario: Reopen after registration or upgrade
- **WHEN** a user registers successfully or upgrades the desktop application while their saved session remains valid
- **THEN** the next launch restores that session without another sign-in

### Requirement: Credential-store failure feedback
If the OS credential store cannot save or read a session, the desktop app SHALL show a recoverable explanation and offer retry. A successful authenticated session SHALL remain usable for the current run after a save failure, with a message that sign-in was not remembered. The app SHALL NOT fall back to storing credentials in ordinary files or browser storage.

#### Scenario: Save fails
- **WHEN** the server accepts a desktop sign-in but the credential store refuses the write
- **THEN** the current session works and the user is told it could not be remembered, with a retry action

#### Scenario: Read fails at startup
- **WHEN** the saved session cannot be read because the credential store is locked or unavailable
- **THEN** the app reports the problem, offers retry, and allows sign-in or local mode without deleting the unread credential

### Requirement: Sessions isolated by server
Remembered desktop sessions and cached account identities SHALL be scoped to the server that issued them. Switching servers SHALL NOT send the former server's token to the new server or show its cached user as the new server's account. A compatible existing saved session SHALL be migrated only when its issuing server can be established safely.

#### Scenario: Change the server
- **WHEN** a user signed in to server A switches to server B
- **THEN** only a session belonging to B can be restored, and no token belonging to A is sent to B

#### Scenario: Return to a known server
- **WHEN** the user switches back to A with an unrevoked session still saved for A
- **THEN** that session can restore their account on A

#### Scenario: Existing unscoped credential
- **WHEN** a prior installation has a saved token without a known issuing server
- **THEN** it is not tested against an arbitrary selected server, and the user is asked to sign in if safe attribution is unavailable

### Requirement: Remembered session invalidation and offline recovery
Sign-out SHALL clear the in-memory session and prevent its restoration after restart, including when credential deletion fails. An expired or revoked session rejected by the server SHALL be forgotten. A network outage SHALL retain saved credentials and permit the existing cached offline experience. Cached identity SHALL NOT confer online authorization.

#### Scenario: Sign out and reopen
- **WHEN** the user signs out and then restarts the desktop app
- **THEN** the prior session is not restored, and a credential deletion failure is reported with retry available

#### Scenario: Remote revocation
- **WHEN** a saved session is rejected after sign-out everywhere, expiry or a password reset
- **THEN** the app stops using it and shows sign-in rather than restoring the cached identity as an online account

#### Scenario: Reopen without network
- **WHEN** a remembered user reopens HiveTeX while the server cannot be reached
- **THEN** their server-scoped cached identity permits existing offline project access, and their token is retained for reconnect

#### Scenario: Local mode is remembered
- **WHEN** a desktop user has chosen Continue without an account
- **THEN** restarting preserves local mode and makes no server requests merely to restore a saved session
