# Spec Delta

## MODIFIED Requirements

### Requirement: GitHub linking
A user SHALL be able to connect their GitHub account with access limited to repositories they select. GitHub access tokens SHALL be stored only on the user's device and SHALL NOT be persisted by the control plane. The authorization flow SHALL only deliver a token to the same user and device that started it.

#### Scenario: Connect GitHub
- **WHEN** a user completes the GitHub authorization flow
- **THEN** their device holds a token scoped to the selected repositories and the control plane stores only the GitHub username link

#### Scenario: Forwarded authorization link
- **WHEN** user A starts linking GitHub and sends the authorization URL to user B, who opens it and authorizes
- **THEN** no token is delivered to A's device, B's GitHub account is not linked to A, and B sees that the link could not be completed

### Requirement: Project-to-repository binding
An owner SHALL be able to bind a project to a new or existing GitHub repository and branch. Only owners SHALL change the binding. The binding recorded on the control plane by an owner SHALL be the only repository the backup writer pushes to.

#### Scenario: Create new private repo
- **WHEN** an owner chooses "Back up to new private repository"
- **THEN** a private repository is created and the current project state is committed to it

#### Scenario: Binding changed by a non-owner peer
- **WHEN** an editor's device writes a different repository into the shared project metadata
- **THEN** the backup writer does not push to that repository and the backup status shows that the binding does not match the owner's setting
