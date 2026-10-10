# Accounts, recovery and administration

## Accounts

- **Sign up**: username (3–32 chars of `a-z 0-9 _ -`, case-insensitive), email, password (≥ 12 characters, not in a breach list).
  Passwords are checked against the Have-I-Been-Pwned *range* API (only a 5-character SHA-1 prefix leaves the
  server) with a small bundled list as offline fallback, then stored as **argon2id** hashes only.
- **Sessions**: web uses an `HttpOnly`, `Secure`, `SameSite=Lax` cookie (`__Host-p2p_session`); the desktop app
  gets a bearer token that it keeps in the OS credential store. Sessions expire after 30 days of inactivity and can be
  revoked ("Sign out of all devices").
- **Brute-force protection**: per-IP rate limits on sign-in/registration/recovery, and a 15-minute lock on an account after
  10 failed attempts. Error messages are identical for "unknown user" and "wrong password".

## Email verification and recovery

A verified email is required for recovery. Reset links are single-use, stored hashed, valid for 30 minutes, and sign the
user out everywhere once used. Requesting a reset never reveals whether an address is registered.

The server sends mail through Gmail SMTP. Create a dedicated Google account, enable 2-step verification, create an
**App Password**, and set `GMAIL_USER` / `GMAIL_APP_PASSWORD` (see `docs/deployment.md`).

## Platform administrators

Admins are created **out of band** — never through the API:

```bash
# production (Neon)
DATABASE_URL=postgres://… pnpm --filter @hivetex/server seed-admin <username>

# local development database (embedded Postgres in .data/pg)
DATA_DIR=.data/pg pnpm --filter @hivetex/server seed-admin <username>
```

The user must already have registered. After signing in, an admin opens **Admin** in the top bar. Admin actions require
the password to be re-entered (valid for 10 minutes).

### Force password reset

*Admin → search user → "Force password reset"*. This immediately:

1. replaces the stored hash with an unusable random secret (the old password stops working),
2. revokes every session of the account,
3. emails a reset link to the account's verified address (if the email is not verified, nothing is sent),
4. writes an entry to the audit log (`admin.force_password_reset`, actor, target, time).

Non-admins calling the endpoint get `403`.

## Where the data lives

`users`, `sessions`, `email_tokens`, `audit_log` … are in Postgres (Neon). Passwords, reset tokens and session tokens are
stored only as hashes. See `design.md` (D9/D10) for the full schema.
