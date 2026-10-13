# user-accounts Specification

## Purpose

Gives every person using HiveTeX a durable identity (username + password) with secure sessions, self-service email recovery and platform-admin recovery tools, so project permissions can be bound to real accounts.

## Requirements

### Requirement: Account registration
The system SHALL let a person create an account with a unique username, an email address and a password. Usernames SHALL be 3–32 characters of `[a-z0-9_-]`, compared case-insensitively. Passwords SHALL be at least 12 characters and SHALL be rejected if they appear in a known-breached password list. A failure to send the verification email SHALL NOT fail the registration. The registration screen SHALL check username format, password length and matching repeat password while the user types, show each rule next to its field, and offer to show the password; the server's checks remain authoritative.

#### Scenario: Successful registration
- **WHEN** a visitor submits an unused username, a valid email and a compliant password
- **THEN** the account is created, an email-verification message is sent, and the user is signed in

#### Scenario: Username taken
- **WHEN** a visitor submits a username that already exists (ignoring case)
- **THEN** registration is rejected with a "username unavailable" error and no account is created

#### Scenario: Weak password
- **WHEN** a visitor submits a password shorter than 12 characters or present in the breached list
- **THEN** registration is rejected with an explanation and no account is created

#### Scenario: Mail server unavailable
- **WHEN** a visitor registers while the mail server is unreachable
- **THEN** the account is created and the user is signed in, and they can request a new verification email later

#### Scenario: Rules shown while typing
- **WHEN** a visitor types an 8-character password
- **THEN** the screen shows that 12 characters are required before they submit, and marks the rule as met once the
  password reaches 12 characters

#### Scenario: Server error shown at the field
- **WHEN** the server rejects the username as unavailable
- **THEN** the message appears under the Username field and is announced to screen readers

### Requirement: Password storage
The system MUST store only a memory-hard salted hash of each password and MUST never log, return or transmit the plaintext password after receipt.

#### Scenario: Database contents
- **WHEN** an operator inspects the accounts store
- **THEN** no plaintext or reversibly-encrypted password is present for any account

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

### Requirement: Brute-force protection
The system SHALL rate-limit sign-in, registration and recovery requests per IP address and per account, and SHALL temporarily lock an account's password sign-in after repeated failures.

#### Scenario: Repeated failures
- **WHEN** more than 10 failed sign-in attempts for one account occur within 15 minutes
- **THEN** further password attempts for that account are refused for 15 minutes with a generic error

### Requirement: Email recovery
The system SHALL let a user request a password reset by email. The reset link SHALL be single-use, expire after 30 minutes, and invalidate all existing sessions once used. The request response SHALL NOT reveal whether the email is registered.

#### Scenario: Reset requested for registered email
- **WHEN** a user requests a reset for a registered, verified email
- **THEN** a reset link is emailed and the UI shows a neutral "if the address exists, an email was sent" message

#### Scenario: Reset requested for unknown email
- **WHEN** a reset is requested for an email that is not registered
- **THEN** no email is sent and the UI shows the same neutral message

#### Scenario: Expired or reused link
- **WHEN** a reset link older than 30 minutes or already used is opened
- **THEN** the reset is refused and the user is told to request a new link

### Requirement: Email verification
The system SHALL require an account's email to be verified before it is used for recovery.

#### Scenario: Unverified email
- **WHEN** a reset is requested for an account whose email is not verified
- **THEN** no reset email is sent

### Requirement: Platform admin force password reset
The system SHALL provide a platform-admin role. A platform admin SHALL be able to force a password reset on any account, which invalidates the account's sessions and requires a new password at next sign-in. Each forced reset SHALL be recorded in an audit log.

#### Scenario: Admin forces reset
- **WHEN** a platform admin triggers "force password reset" on an account
- **THEN** all sessions of that account end, the old password stops working, a reset email is sent to the account's verified email, and an audit entry records admin, target and time

#### Scenario: Non-admin attempts force reset
- **WHEN** a user without the platform-admin role calls the force-reset action
- **THEN** the request is rejected as forbidden and nothing changes

### Requirement: Password change
The system SHALL let a signed-in user change their password after re-entering the current password, and SHALL invalidate all their other sessions.

#### Scenario: Change password
- **WHEN** a signed-in user submits the correct current password and a compliant new password
- **THEN** the password is updated and all other sessions are ended

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
