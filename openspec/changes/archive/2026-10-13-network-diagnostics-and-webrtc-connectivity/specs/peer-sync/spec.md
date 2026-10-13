# Spec Delta

## ADDED Requirements

### Requirement: Early connection-setup messages are retained
A device SHALL NOT discard a connection-setup message (including network candidates) for a peer merely because it arrives before that device has finished creating its side of the connection; it SHALL apply them once the connection exists.

#### Scenario: Candidates before the link exists
- **WHEN** candidates from the offering device arrive while the answering device is still obtaining connection configuration
- **THEN** they are applied after the offer is processed and the connection can use them

### Requirement: Failed attempts record a cause
Every failed or timed-out connection attempt SHALL record the stage reached and a cause (no setup reply, no candidates received, checks failed, relay unavailable), available to the user interface.

#### Scenario: Timeout cause
- **WHEN** an attempt times out after checks started with no working pair
- **THEN** the recorded cause says connectivity checks failed rather than only "timed out"
