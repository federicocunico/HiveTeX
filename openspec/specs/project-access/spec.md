# project-access Specification

## Purpose

Defines how projects are identified, shared and protected: shareable project IDs, project passwords, membership, roles and the owner's permission management, plus the signed membership tickets peers rely on to enforce access without a central content server.

## Requirements

### Requirement: Project creation and ID
The system SHALL assign every new shared project a unique shareable ID consisting of a readable prefix, a hyphen and a server-generated random suffix with at least 80 bits of entropy. An owner-supplied name SHALL be treated as a prefix, never as the final ID. With no name, a default prefix SHALL be used. IDs SHALL remain within 6–48 lowercase characters of `[a-z0-9-]`. The creator becomes the project owner.

#### Scenario: Custom ID available
- **WHEN** a user creates a project with the name prefix `projecttest`
- **THEN** its returned shareable ID is `projecttest-<random-suffix>` and the user is its owner

#### Scenario: Custom ID taken
- **WHEN** a user requests a name prefix already used by another project
- **THEN** creation succeeds with a new suffixed shareable ID and leaves the other project unchanged

#### Scenario: Generated ID
- **WHEN** a user creates a project without a name prefix
- **THEN** a default readable prefix and random suffix are assigned and the final ID is shown with a copy/share action

#### Scenario: Older client submits a plain ID
- **WHEN** an authenticated caller uses the existing creation request field to submit `projecttest`
- **THEN** the server interprets it as a prefix and returns a suffixed ID, never registering a new plain-name ID

#### Scenario: Folder, template, import or publish creation
- **WHEN** a shared project is created from a template, folder, imported source or local-only project
- **THEN** its ID follows the same suffix convention and its local files remain associated with the returned internal project identity

### Requirement: Project ID change
The owner SHALL be able to change the readable prefix of a shareable project ID. Every changed ID SHALL receive a server-generated random suffix under the creation convention; the old ID SHALL stop resolving immediately. A no-op update SHALL preserve the existing ID, including a legacy ID. Changing the shareable ID SHALL preserve the immutable internal project identity, contents and memberships.

#### Scenario: Rename ID
- **WHEN** the owner changes the prefix from `old-id` to `new-id`
- **THEN** joining with the old shareable ID fails as not found and joining with the returned `new-id-<random-suffix>` works

#### Scenario: Rename cannot remove the suffix
- **WHEN** the owner requests a plain-name ID for an existing project
- **THEN** the server assigns a suffixed replacement rather than an unsuffixed new ID

#### Scenario: Unrelated settings on a legacy project
- **WHEN** an owner updates permissions or passwords without changing a legacy shareable ID
- **THEN** that ID continues resolving without modification

### Requirement: Project password
Projects SHALL be password-protected by default. The owner SHALL be able to set, change or disable the project password. Project passwords SHALL be stored only as memory-hard hashes.

#### Scenario: Default protection
- **WHEN** a project is created
- **THEN** the creation flow requires setting a project password unless the owner explicitly disables protection

#### Scenario: Password change does not evict members
- **WHEN** the owner changes the project password
- **THEN** existing members keep access and only new joins require the new password

### Requirement: Joining a project
A signed-in user SHALL join a project by entering its ID and, if protected, its password. On success the user becomes a member immediately with the project's default role.

#### Scenario: Correct ID and password
- **WHEN** a signed-in user enters an existing project ID and the correct password
- **THEN** the user is added as a member with the default role and the project opens

#### Scenario: Wrong password or unknown ID
- **WHEN** a user enters an unknown ID or a wrong password
- **THEN** the join fails with the same generic "project not found or wrong password" error

#### Scenario: Join attempt rate limiting
- **WHEN** more than 5 failed join attempts for one project ID come from one account or IP within 15 minutes
- **THEN** further join attempts from that account/IP for that project are refused for 15 minutes

#### Scenario: Project ID scanning
- **WHEN** more than 20 failed join attempts across any project IDs come from one account or IP within 15 minutes
- **THEN** further join attempts from that account/IP are refused for 15 minutes, for every project ID

#### Scenario: Removed user rejoins
- **WHEN** a user previously removed by the owner and marked "banned" tries to join with the correct password
- **THEN** the join is refused

### Requirement: Roles
Each membership SHALL have exactly one role: `owner`, `editor` or `viewer` (read-only). Owners and editors MAY modify project content; viewers MAY only read content and view compiled output. There SHALL be no limit on the number of members.

#### Scenario: Viewer cannot edit
- **WHEN** a viewer opens a project
- **THEN** the editor is read-only and the viewer's client does not produce content changes

### Requirement: Default role
The owner SHALL configure the role given to new joiners; the initial default SHALL be `viewer`.

#### Scenario: Default changed to editor
- **WHEN** the owner sets the default role to `editor` and a new user joins
- **THEN** the new member's role is `editor`

### Requirement: Owner permission management
Only owners SHALL be able to change members' roles, remove members, ban members, change the default role, change the ID or password, and transfer or share ownership. A project SHALL always keep at least one owner.

#### Scenario: Owner changes a role
- **WHEN** an owner changes a member from `editor` to `viewer`
- **THEN** the change is recorded and connected peers enforce the new role within the ticket refresh window

#### Scenario: Non-owner attempts management
- **WHEN** an editor or viewer attempts any owner-only action
- **THEN** the request is rejected as forbidden

#### Scenario: Last owner protection
- **WHEN** the only owner attempts to demote or remove themself
- **THEN** the action is rejected until another owner exists

### Requirement: Membership tickets
The control plane SHALL issue each member device a signed, short-lived (≤ 15 minutes) membership ticket stating project, user, device public key, role and membership epoch. Peers SHALL verify tickets offline against the control plane's published public key.

#### Scenario: Ticket refresh
- **WHEN** a member's ticket is within 3 minutes of expiry and the control plane is reachable
- **THEN** the client obtains a fresh ticket without user interaction

#### Scenario: Forged ticket
- **WHEN** a peer presents a ticket whose signature does not verify
- **THEN** every receiving peer refuses the connection

### Requirement: Revocation
Removing a member or lowering a role SHALL increment the project's membership epoch. Connected peers SHALL disconnect or downgrade a peer whose ticket is revoked, at the latest when that ticket expires. A peer SHALL NOT regain a role by presenting a ticket older than one it already presented.

#### Scenario: Member removed while connected
- **WHEN** an owner removes a member whose device is currently connected
- **THEN** within 15 minutes all honest peers stop exchanging data with that device, and the removed member cannot obtain new tickets

#### Scenario: Old ticket replay after demotion
- **WHEN** a member demoted from editor to viewer presents their new viewer ticket and then re-sends an older, still unexpired editor ticket
- **THEN** peers keep treating the member as a viewer and drop their document updates

### Requirement: Project listing
A signed-in user SHALL see the list of projects they are a member of with their role, ordered by when they last opened each project on any of their devices, and owners SHALL see the list of members with roles. The control plane SHALL store only the time of opening, never content or local folder paths.

#### Scenario: Member list
- **WHEN** an owner opens project settings
- **THEN** every member's username, role, join date and online status (if known) are listed

#### Scenario: Recents across devices
- **WHEN** a user opens project B on their laptop and then looks at the projects page on their desktop computer
- **THEN** project B is listed first, with when it was last opened

#### Scenario: Location on this device
- **WHEN** a project uses a folder on the current device
- **THEN** the projects page shows that folder's name next to the project, and nothing about it is sent to the control plane

### Requirement: Project deletion
An owner SHALL be able to delete a project's registry entry; this SHALL invalidate all memberships and tickets. Local copies on devices are not deleted remotely.

#### Scenario: Project deleted
- **WHEN** an owner deletes a project
- **THEN** the ID stops resolving, no new tickets are issued, and members see the project marked as deleted with an option to export their local copy

### Requirement: Authoritative membership epochs
A device SHALL advance its enforced membership epoch only from a verified control-plane statement for the same project. A peer's unsupported numeric claim SHALL NOT revoke other members, change enforced policy, or cause repeated ticket refreshes. Relayed authority SHALL be verified before use.

#### Scenario: Viewer invents an epoch
- **WHEN** a viewer announces an epoch greater than every verified membership ticket
- **THEN** honest peers keep their verified epoch and do not disconnect members or repeatedly refresh tickets because of that claim

#### Scenario: Valid newer authority
- **WHEN** a peer supplies a valid same-project ticket carrying a newer epoch
- **THEN** the device advances its epoch and applies the existing refresh and revocation policy

### Requirement: Current authorization for delayed work
Document mutation and application-level privileged actions SHALL be authorized against the current verified peer identity and role when applied. Closing, replacing, or downgrading a connection SHALL invalidate delayed work that no longer has authorization. A reconnect SHALL NOT reset a device's known ticket freshness within the receiving session.

#### Scenario: Demotion while document loading waits
- **WHEN** an editor's update awaits document loading and their verified role changes to viewer before application
- **THEN** the delayed update is not applied or forwarded

#### Scenario: Reconnect with an older ticket
- **WHEN** a device presents a newer viewer ticket and reconnects with its older editor ticket
- **THEN** the receiver does not restore editor privileges

#### Scenario: Data from a replaced connection
- **WHEN** document processing from an older connection completes after that device establishes a replacement
- **THEN** the old callback cannot mutate the active project through obsolete authorization

### Requirement: Authoritative uniqueness on new IDs
The server SHALL enforce shareable-ID uniqueness atomically and retry a conflicting generated candidate with fresh randomness. Concurrent creations with the same prefix SHALL not overwrite another project or return its ID. If bounded retries are exhausted, the request SHALL fail clearly without a partial project or ownership record. Unrelated storage failures SHALL NOT be reported as naming conflicts.

#### Scenario: Forced random collision
- **WHEN** a generated ID conflicts with an existing ID
- **THEN** the server retries with a fresh suffix and registers only an unused ID

#### Scenario: Concurrent same-name requests
- **WHEN** two creation requests use the same prefix concurrently
- **THEN** both successful responses identify distinct projects and each creator has ownership of their own project

#### Scenario: Retry exhaustion
- **WHEN** every permitted generated candidate conflicts
- **THEN** creation fails with a retryable explanation, no new project or membership is left behind, and existing projects are unchanged

### Requirement: Legacy project IDs remain usable
Existing unsuffixed IDs SHALL continue to resolve for joining, listing, opening and sharing without automatic renaming. Existing internal IDs, local caches, folder markers, memberships and peer authorization SHALL remain valid. New shared-project ID assignment SHALL always use the new convention; local-only projects SHALL retain their existing UUID identity and acquire a suffixed share ID when published.

#### Scenario: Join an existing plain-name project
- **WHEN** a member joins a pre-existing unsuffixed project using its ID and required password
- **THEN** the normal membership and opening flow succeeds

#### Scenario: Open a legacy folder binding
- **WHEN** a user opens a folder marked for a legacy project
- **THEN** it resolves to the existing project without migrating its internal identity or overwriting its contents

#### Scenario: Create the name of a legacy project
- **WHEN** a new project is created with the same prefix as a legacy plain-name ID
- **THEN** the new project receives a suffixed ID and the legacy ID still resolves to its original project
