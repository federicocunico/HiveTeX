# Spec Delta

## MODIFIED Requirements

### Requirement: NAT traversal fallback
When a direct connection cannot be established, capable clients SHALL keep syncing through the end-to-end encrypted application relay on the existing server whenever the deployment enables it, it is reachable and within budget, without requiring a separately configured TURN provider. Configured TURN SHALL be used when it works and SHALL NOT be a prerequisite for synchronization. Desktop automatic port mapping SHALL supplement direct connectivity without blocking either relay path.

#### Scenario: Symmetric NAT
- **WHEN** two peers cannot connect directly
- **THEN** they connect through the relay and sync continues, with content still end-to-end encrypted

#### Scenario: UPnP mapping fails
- **WHEN** automatic port mapping is unavailable, rejected or ineffective
- **THEN** the peers can still establish an ordinary direct connection or use configured TURN or the application relay without manual port configuration

#### Scenario: TURN gathered but unusable
- **WHEN** both peers gather relay candidates from configured TURN but no candidate pair passes connectivity checks
- **THEN** synchronization continues through the application relay and the failed WebRTC attempt is recorded with its cause

### Requirement: Safe transport selection
When two capable peers that both reach the server learn of each other, clients SHALL start the application relay without waiting for a WebRTC attempt to fail, and SHALL attempt direct WebRTC or configured TURN in parallel. A WebRTC link SHALL become the route only after it has authenticated and carried traffic; the relay SHALL stay available until then. UPnP and TURN SHALL NOT be prerequisites. A transport switch SHALL preserve edits and current authorization with one authoritative peer connection generation.

#### Scenario: Direct and TURN unavailable
- **WHEN** two capable peers can reach the application server but direct WebRTC and TURN are unavailable
- **THEN** they synchronize through the authenticated application relay within 5 seconds of learning each other's available relay capability, independently of WebRTC attempt timeouts

#### Scenario: Direct connectivity recovers
- **WHEN** a working direct path becomes available while peers use the application relay
- **THEN** a coordinated authenticated handover resumes synchronization without lost edits, duplicate active ownership or stale callbacks

#### Scenario: Direct link not yet proven
- **WHEN** a WebRTC link has connected but has not yet carried authenticated traffic in both directions
- **THEN** edits keep flowing through the application relay and the route shown is the relay

#### Scenario: Relay unavailable too
- **WHEN** direct, TURN and application relay paths cannot connect
- **THEN** the app preserves local edits, reports unavailability and retries with bounded backoff rather than promising guaranteed connectivity

#### Scenario: Server without relay capability
- **WHEN** the server or the other peer does not offer the application relay
- **THEN** clients keep the previous behaviour: direct WebRTC, then configured TURN, with bounded retries

### Requirement: Zero idle control-plane cost
A device with no connected peer need and no introduction in progress SHALL hold no connection to the control plane and SHALL send no presence heartbeats, ticket renewals or polling requests. Signaling sockets SHALL exist only while an introduction is in progress, a seen device is still being connected, or an application-relay link is a route; they SHALL close once every wanted link is a direct WebRTC route or the introduction window ends. Peers linked directly SHALL exchange edits without the control plane.

#### Scenario: Idle seed overnight
- **WHEN** a desktop seed has no peer and nobody rings its projects for hours
- **THEN** it makes no request to the control plane and holds no signaling socket during that time

#### Scenario: Editing with connected peers
- **WHEN** members are linked to each other over direct WebRTC or TURN and edit
- **THEN** no device keeps a gatekeeper socket open and edits do not use the control plane

#### Scenario: Editing over the application relay
- **WHEN** two members can only reach each other through the application relay
- **THEN** their signaling sockets stay open for the relay route, within the deployment's relay budget, and close when a direct route takes over or the members leave

## ADDED Requirements

### Requirement: Silent direct links hand back to the relay
When a WebRTC route stops carrying traffic (its connection reports disconnected or failed, or acknowledgements stop), the client SHALL move synchronization to the application relay without waiting for the WebRTC stack to declare failure, and SHALL end the silent link so a fresh attempt can be made.

#### Scenario: Path dies after connecting
- **WHEN** a direct link goes disconnected seconds after connecting and does not recover
- **THEN** edits continue through the application relay within 2 seconds of the disconnection, the dead link is ended, and a new direct attempt is scheduled with bounded backoff

#### Scenario: Short interruption
- **WHEN** a direct link reports disconnected and recovers before the grace period ends
- **THEN** edits sent meanwhile through the relay are not applied twice in a way that changes the result, and the direct route resumes

### Requirement: Connection attempts outlive the stack's own checks
A WebRTC connection attempt SHALL NOT be abandoned by the client before the connection stack itself has had the time it is configured to take for connectivity checks, including relay candidates.

#### Scenario: Relay pair needs the full check window
- **WHEN** only relay candidate pairs can succeed and their checks complete after the direct pairs failed
- **THEN** the attempt is still alive when they complete and the link connects through the relay
