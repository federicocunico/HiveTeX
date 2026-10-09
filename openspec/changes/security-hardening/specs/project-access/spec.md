# Spec Delta

## MODIFIED Requirements

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

### Requirement: Revocation
Removing a member or lowering a role SHALL increment the project's membership epoch. Connected peers SHALL disconnect or downgrade a peer whose ticket is revoked, at the latest when that ticket expires. A peer SHALL NOT regain a role by presenting a ticket older than one it already presented.

#### Scenario: Member removed while connected
- **WHEN** an owner removes a member whose device is currently connected
- **THEN** within 15 minutes all honest peers stop exchanging data with that device, and the removed member cannot obtain new tickets

#### Scenario: Old ticket replay after demotion
- **WHEN** a member demoted from editor to viewer presents their new viewer ticket and then re-sends an older, still unexpired editor ticket
- **THEN** peers keep treating the member as a viewer and drop their document updates
