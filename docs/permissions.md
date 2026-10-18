# Projects, roles and permissions

## Joining

Every new shared project has a unique **project ID**: a readable name prefix plus a hyphen and a server-generated
16-character base32 suffix (80 random bits), such as `paper-abcdefghijklmnop`. Repeated names are allowed. Copy the
complete ID from Share. Existing plain-name IDs still work; they are never renamed automatically. Joining needs the ID and, by default, the **project password**. Anyone who joins is a member
immediately with the project's **default role** (initially `viewer`). Failed joins are rate-limited (5 per 15 minutes per
account and per IP); wrong ID and wrong password give the same error.

## Roles

| Role | Read & preview | Edit content | Recompile | Manage members / settings |
|---|---|---|---|---|
| `owner` | ✔ | ✔ | ✔ | ✔ (no limit on members; ≥ 1 owner always) |
| `editor` | ✔ | ✔ | ✔ | – |
| `viewer` | ✔ | – (enforced by every peer) | ✔ (builds locally) | – |

Owners can: change roles, remove or **ban** members, set the default role, change/disable the project password, change the
project name prefix (the server returns a newly suffixed ID; the old one stops resolving immediately), link GitHub, and delete the project.

## How access is enforced without a content server

The control plane issues each member device a **membership ticket**: an EdDSA-signed token with project, user, device keys,
role and the project's **membership epoch**, valid for **15 minutes**. Peers verify tickets offline against the pinned
control-plane public key and prove possession of the device key bound to the specific encrypted connection.

* **Read-only**: a peer drops every live document operation and blob announcement coming from a connection whose ticket says
  `viewer`, and never forwards them. A tampered viewer client therefore cannot change anyone's copy.
* **Revocation timing**: removing a member or lowering a role bumps the project's *epoch*. Peers gossip the highest epoch
  they have seen; a peer whose ticket carries an older epoch must present a refreshed one within **60 seconds** or it is
  disconnected. A removed user cannot obtain a new ticket. Hard upper bound: the 15-minute ticket lifetime.
* Removal does **not** erase the copy already on the removed member's device (inherent to local-first software).

## Spec checklist (review)

| Spec scenario | Where it is verified |
|---|---|
| Name prefix / duplicate names / generated suffix / legacy IDs | `server/test/projects.test.ts` › project creation |
| Join with correct ID+password, generic errors, rate limit, banned user | › joining |
| Owner-only management, last-owner protection, slug change, password rotation | › owner management |
| Ticket claims, expiry, forged ticket, removed member | › devices and tickets; `packages/crypto/test` |
| Viewer cannot edit (tampered client) | `packages/sync/test/mesh.test.ts` › role enforcement; `e2e/auth-and-collab.spec.ts` |
| Revocation within the grace window | `packages/sync/test/mesh.test.ts` › membership epoch policy |
