# Spec Delta

## MODIFIED Requirements

### Requirement: Peer discovery and connection bootstrap
A member device SHALL discover other online member devices of the project and establish encrypted peer connections. Connection-setup messages relayed by the control plane MUST be end-to-end encrypted between the two devices. A device SHALL prove possession of its device key to the signaling relay before it is announced to other members.

#### Scenario: Second member comes online
- **WHEN** member A is editing and member B opens the same project
- **THEN** A and B establish a direct encrypted connection and B's copy converges with A's

#### Scenario: Already in the mesh
- **WHEN** a device is already connected to at least one peer and a new peer appears
- **THEN** the connection to the new peer MAY be negotiated through existing peers instead of the control plane

#### Scenario: Copied ticket
- **WHEN** a member connects to the signaling relay with another member's ticket but without that device's private key
- **THEN** the relay refuses the connection and other members see no presence change for that device

### Requirement: Binary asset transfer
Binary files SHALL be transferred by content hash in chunks, fetched on demand from any peer holding them, and verified against their hash before use. A transfer whose declared size exceeds the project's maximum file size SHALL be rejected.

#### Scenario: Image added
- **WHEN** an editor adds a 5 MB image
- **THEN** peers fetch it in verified chunks, possibly from multiple peers, without blocking text sync

#### Scenario: Corrupt chunk
- **WHEN** a received chunk does not match its expected hash
- **THEN** it is discarded and re-requested from another peer

#### Scenario: Oversized transfer
- **WHEN** a peer announces a chunk count implying a blob larger than the maximum file size
- **THEN** the receiving device ignores that transfer without allocating memory for it and tries other peers
