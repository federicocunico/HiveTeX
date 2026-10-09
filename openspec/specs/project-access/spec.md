# project-access Specification

## Purpose

Defines how projects are identified, shared and protected: shareable project IDs, project passwords, membership, roles and the owner's permission management, plus the signed membership tickets peers rely on to enforce access without a central content server.

## Requirements

### Requirement: Project creation and ID
The system SHALL assign every new project a unique project ID at creation. The owner MAY supply a custom ID of 6–48 characters of `[a-z0-9-]`; otherwise a random, unguessable ID (≥ 80 bits of entropy) is generated. The creator becomes the project owner.

#### Scenario: Custom ID available
- **WHEN** a user creates a project with an unused custom ID
- **THEN** the project is registered under that ID with the user as owner

#### Scenario: Custom ID taken
- **WHEN** a user requests a custom ID that already exists
- **THEN** creation is rejected with "ID unavailable" and a suggestion is offered

#### Scenario: Generated ID
- **WHEN** a user creates a project without a custom ID
- **THEN** a random ID is assigned and shown with a copy/share action

### Requirement: Project ID change
The owner SHALL be able to change the project ID to another unused ID; the old ID SHALL stop resolving immediately.

#### Scenario: Rename ID
- **WHEN** the owner changes the ID from `old-id` to an unused `new-id`
- **THEN** joining with `old-id` fails as "not found" and joining with `new-id` works

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
A signed-in user SHALL see the list of projects they are a member of with their role, and owners SHALL see the list of members with roles.

#### Scenario: Member list
- **WHEN** an owner opens project settings
- **THEN** every member's username, role, join date and online status (if known) are listed

### Requirement: Project deletion
An owner SHALL be able to delete a project's registry entry; this SHALL invalidate all memberships and tickets. Local copies on devices are not deleted remotely.

#### Scenario: Project deleted
- **WHEN** an owner deletes a project
- **THEN** the ID stops resolving, no new tickets are issued, and members see the project marked as deleted with an option to export their local copy
