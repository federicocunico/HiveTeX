# Spec Delta

## MODIFIED Requirements

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
