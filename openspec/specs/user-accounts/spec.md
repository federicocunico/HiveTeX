# user-accounts Specification

## Purpose

Gives every person using HiveTeX a durable identity (username + password) with secure sessions, self-service email recovery and platform-admin recovery tools, so project permissions can be bound to real accounts.

## Requirements

### Requirement: Account registration
The system SHALL let a person create an account with a unique username, an email address and a password. Usernames SHALL be 3–32 characters of `[a-z0-9_-]`, compared case-insensitively. Passwords SHALL be at least 12 characters and SHALL be rejected if they appear in a known-breached password list. A failure to send the verification email SHALL NOT fail the registration.

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

### Requirement: Password storage
The system MUST store only a memory-hard salted hash of each password and MUST never log, return or transmit the plaintext password after receipt.

#### Scenario: Database contents
- **WHEN** an operator inspects the accounts store
- **THEN** no plaintext or reversibly-encrypted password is present for any account

### Requirement: Sign-in and sessions
The system SHALL authenticate users by username (or email) and password and issue a session. Web sessions SHALL use secure, HttpOnly, SameSite cookies; desktop sessions SHALL use a token kept in the OS credential store. Sessions SHALL expire after 30 days of inactivity and SHALL be revocable.

#### Scenario: Correct credentials
- **WHEN** a user submits valid credentials
- **THEN** a session is issued and the user reaches their project list

#### Scenario: Wrong credentials
- **WHEN** a user submits an unknown username or a wrong password
- **THEN** the same generic "invalid credentials" error is returned in both cases

#### Scenario: Sign out everywhere
- **WHEN** a user chooses "sign out of all devices"
- **THEN** every existing session of that user is invalidated

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
