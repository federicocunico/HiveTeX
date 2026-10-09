# Spec Delta

## MODIFIED Requirements

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
