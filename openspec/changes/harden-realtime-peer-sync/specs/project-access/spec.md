# Spec Delta

## ADDED Requirements

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
