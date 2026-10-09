# Spec Delta

## ADDED Requirements

### Requirement: Real-time propagation at group scale
With up to 12 connected member devices on a healthy connection, an edit SHALL reach every other device within 250 ms at the 95th percentile, and each edit SHALL be sent at most once over each peer connection in a fully connected mesh. When some devices cannot connect directly, edits SHALL still reach every device through the others.

#### Scenario: Seven co-authors typing
- **WHEN** seven members are connected and one types a character
- **THEN** the other six see it within 250 ms (95th percentile over a typing session)

#### Scenario: Everyone types at once
- **WHEN** all connected members type concurrently in the same file
- **THEN** every device converges to identical text containing every insertion

#### Scenario: No duplicate relaying in a full mesh
- **WHEN** twelve devices are all directly connected and one edits a file
- **THEN** the edit is sent once to each of the eleven others and is not forwarded again by them

#### Scenario: Partial mesh
- **WHEN** devices A and B cannot connect directly but both are connected to C
- **THEN** A's edits reach B through C, without duplicates being re-forwarded endlessly
