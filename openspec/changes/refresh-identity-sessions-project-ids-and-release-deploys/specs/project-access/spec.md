# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
