# Spec Delta

## ADDED Requirements

### Requirement: Native connection stack log in reports
On the desktop, the report SHALL include the latest warnings and state changes logged by the native connection stack itself (ICE agent, TURN client, candidate pair selection) and its ICE connection state per peer, bounded in size. The log MUST NOT contain credentials, tokens, keys or document content; addresses SHALL be reduced to their candidate type or masked.

#### Scenario: Relay candidates gathered but checks fail
- **WHEN** an attempt ends with checks failed on the desktop
- **THEN** the report shows the native stack's own lines for that attempt (for example TURN permission or allocation errors, pair failures) next to the connection trace

#### Scenario: No secrets in the native log
- **WHEN** the native stack logs a TURN request
- **THEN** the report shows neither the TURN username nor the credential, and addresses are masked

### Requirement: Relay-only peer test
The peer test SHALL offer a relay-only variant that restricts the WebRTC attempt to relay candidates on every platform, including the desktop native stack, and SHALL report separately whether the application relay carries a test message between the two devices.

#### Scenario: Relay-only test on the desktop
- **WHEN** a desktop member runs the relay-only peer test against an online co-author
- **THEN** only relay candidates are gathered and checked, and the result names the TURN transport used or why no relay candidate worked

#### Scenario: Application relay test
- **WHEN** the deployment offers the application relay and both devices support it
- **THEN** the test reports whether an encrypted test frame reached the other device through it and how long the round trip took
