## ADDED Requirements

### Requirement: Offline work when only viewers are linked
A viewer SHALL NOT be asked to confirm state for an offline merge and SHALL NOT be treated as holding work to merge
with. When the only co-authors linked to a member who can edit are viewers, that member's offline work SHALL be shared
as it is, at once, without waiting for an editor. An editor who links later SHALL merge against the shared state. A
member who lost edit rights SHALL keep the existing behavior: their offline differences are discarded with a notice.

#### Scenario: Only a viewer is online
- **WHEN** an editor with offline work reconnects and the only linked co-author is a viewer
- **THEN** no confirmation is requested, the work is shared at once, and the viewer receives it

#### Scenario: An editor links later
- **WHEN** an editor who changed the same file while unlinked links after the work was shared
- **THEN** their changes are merged with the shared state, and any overlapping change becomes a conflict to resolve
