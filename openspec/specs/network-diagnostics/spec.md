# network-diagnostics Specification

## Purpose
Lets a member see, step by step, whether their device can reach the signaling service, STUN and TURN, whether ports work, and whether they can connect to a specific co-author, so connection problems can be understood and reported.

## Requirements

### Requirement: Networking page
The app SHALL provide a Network diagnostics page, reachable from the workspace and the account area, that runs connectivity checks on demand and shows each one as passed, failed or not applicable with a plain-language reason.

#### Scenario: Run all checks
- **WHEN** the member opens the page and starts the checks
- **THEN** signaling, ICE configuration, STUN, TURN and (on desktop) port mapping each show a result and a duration

#### Scenario: Check not applicable
- **WHEN** a check does not apply to the platform (port mapping in a browser)
- **THEN** it is shown as not applicable, not as failed

### Requirement: ICE configuration visibility
The page SHALL state which STUN servers were offered and whether relay (TURN) credentials were issued. A missing or failed credential issuance MUST be reported as such, and the credentials themselves MUST NOT be displayed or copied.

#### Scenario: TURN not configured
- **WHEN** the service issues no relay credentials
- **THEN** the page reports "no relay available" and explains that peers behind strict NATs may be unable to connect

### Requirement: Reachability probes
The page SHALL probe STUN reachability and show the discovered public address and whether the mapping looks endpoint-independent, and SHALL probe relay reachability when credentials exist.

#### Scenario: UDP blocked
- **WHEN** no STUN response arrives
- **THEN** the page reports UDP as blocked and whether a TCP/TLS relay route was reachable

### Requirement: Per-peer connection details
For every co-author who is online but not connected, and for connected ones, the page SHALL show the connection state, attempt count, the stage reached (signaling, candidates exchanged, checks, connected), local and remote candidate types gathered, the selected route, and the last failure cause.

#### Scenario: Stuck at candidate exchange
- **WHEN** an attempt times out and no remote candidate was received
- **THEN** the details name "no candidates received from the other device" as the cause

#### Scenario: Connected
- **WHEN** the link is up
- **THEN** the details show direct, relay-through-TURN or application relay as the route

### Requirement: Peer test
Two online members SHALL be able to run a peer test from the page that attempts a fresh connection between them and reports success and the route, or the stage and cause of failure on both sides.

#### Scenario: Test between two members
- **WHEN** a member starts a peer test against an online co-author
- **THEN** both devices attempt a connection and the initiator sees the outcome within the attempt timeout

#### Scenario: Co-author offline
- **WHEN** the chosen co-author is not online
- **THEN** the test is not started and the page says so

### Requirement: Shareable diagnostic report
The page SHALL offer *Copy report* producing text with all check results, ICE configuration summary, candidate types and per-peer details, and MUST exclude credentials, tokens, keys and document content.

#### Scenario: Copy report
- **WHEN** the member selects Copy report
- **THEN** the clipboard holds the report and it contains no credential or token value

### Requirement: Connection trace
The connection layer SHALL be able to emit an ordered, timestamped trace of its operations per peer (configuration requested and received, attempts started, setup messages sent, received and held, candidates, link state changes, failures with their cause, retries and relay fallback). A trace MUST NOT contain credentials, keys, tokens, addresses or document content.

#### Scenario: Trace of a failed connection
- **WHEN** a connection attempt fails
- **THEN** the trace lists, in order, each step taken towards that peer up to and including the failure and its cause

### Requirement: Sync tests print the trace
Automated tests that exercise peer connection and sync SHALL record the connection trace of every participant and print it, with participant names and relative times, when the test fails or times out.

#### Scenario: Failing sync test
- **WHEN** a connection or sync test fails
- **THEN** the test output includes the merged trace of all participants so the step where it stopped is visible without re-running

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
