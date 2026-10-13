# Spec Delta

## Purpose

Improves direct desktop peer connectivity by automatically managing UPnP gateway mappings for the actual encrypted peer transport, while preserving user control, mapping ownership and relay fallback.

## ADDED Requirements

### Requirement: Automatic UPnP discovery
When automatic port mapping is enabled and an authorized desktop synchronization session needs connectivity, the desktop SHALL attempt bounded UPnP IGD discovery on its selected local network. Mapping SHALL be enabled by default and independently disableable. Browser clients, signed-out operation, local mode and globally paused synchronization SHALL not initiate discovery or create mappings.

#### Scenario: Supported home router
- **WHEN** an authorized desktop session starts on a network with a compatible IGD
- **THEN** it attempts an automatic UDP mapping without asking the user to configure the router manually

#### Scenario: UPnP disabled by the member
- **WHEN** the member disables automatic port mapping
- **THEN** discovery and renewal stop, owned mappings are removed where possible and normal peer connectivity remains available

#### Scenario: Router does not support UPnP
- **WHEN** discovery times out or the router rejects the operation
- **THEN** synchronization continues using available direct or encrypted relay connectivity and retries are bounded

### Requirement: Mapping ownership and least exposure
The desktop SHALL map only UDP sockets bound to its peer transport on the selected interface. It SHALL verify and track each mapping's gateway, internal endpoint, external endpoint, protocol and ownership. It SHALL not overwrite or delete another application's mapping, expose compiler/helper/debug endpoints, request a router DMZ or alter host firewall policy.

#### Scenario: Port already mapped
- **WHEN** the router reports the desired external port belongs to another endpoint
- **THEN** the desktop tries another bounded candidate port or falls back without modifying the other mapping

#### Scenario: Several projects share a listener
- **WHEN** multiple authorized projects use the same transport socket
- **THEN** they share one owned mapping and stopping one project does not remove it while another still needs it

#### Scenario: Untrusted discovery response
- **WHEN** a discovery response points outside the selected local gateway scope or exceeds parsing limits
- **THEN** it is rejected without contacting the supplied destination or blocking synchronization

### Requirement: Mapped endpoint participates in ICE
A mapped endpoint SHALL be advertised only when it corresponds to the live transport socket and an unexpired verified mapping. ICE connectivity checks and the normal encrypted peer authentication SHALL still determine whether it is usable. Mapping success alone SHALL not be reported as a direct peer connection.

#### Scenario: Public endpoint works
- **WHEN** a remote authorized peer can reach a mapped endpoint
- **THEN** a real ICE candidate pair can carry encrypted project traffic through that endpoint

#### Scenario: External port differs
- **WHEN** the gateway offers an external port different from the internal port
- **THEN** the desktop either registers a transport-supported candidate with that exact mapping or rejects the mapping and falls back; it never advertises a fabricated candidate

#### Scenario: Double NAT or CGNAT
- **WHEN** a router accepts a mapping but the resulting endpoint is not reachable by a remote peer
- **THEN** failed connectivity checks leave other ICE paths and encrypted relay fallback available

#### Scenario: Browser peer
- **WHEN** a browser member connects to a desktop seed using UPnP
- **THEN** standard WebRTC negotiation and the existing project authentication work without any browser port-mapping permission

### Requirement: Finite mapping lease and renewal
The desktop SHALL request a finite lease and renew owned mappings before expiry while eligible sessions need them. Renewal failures SHALL invalidate expired mappings and remain retryable. A gateway supporting only permanent mappings SHALL be treated as unsupported for automatic mapping.

#### Scenario: Long active session
- **WHEN** a woken seed or an open project stays active beyond the requested lease duration
- **THEN** the mapping is renewed or its loss is reflected in connectivity state before stale endpoints are advertised for new connections

#### Scenario: Seed goes dormant
- **WHEN** the last active session of a desktop returns to dormant
- **THEN** owned mappings are removed and no discovery or renewal happens until a session wakes again

#### Scenario: Process killed
- **WHEN** the application is killed before cleanup
- **THEN** the finite lease bounds stale exposure and restart verifies ownership before reusing or replacing a mapping

### Requirement: Gateway changes and mapping cleanup
Network change, resume, gateway replacement and mapping loss SHALL trigger bounded revalidation. Disable, global pause, sign-out, last-session stop and orderly quit SHALL attempt removal of only owned mappings. Late results from previous network or account generations SHALL not reactivate mappings or stale peer candidates.

#### Scenario: Move from Wi-Fi to another network
- **WHEN** the default route changes while projects are seeded
- **THEN** old mapping results are invalidated, removal on the old gateway is attempted when reachable, and connectivity is rebuilt for the new network

#### Scenario: Disable during discovery
- **WHEN** the member disables mapping while a gateway request is pending
- **THEN** its late success is cleaned up and cannot enable UPnP again

#### Scenario: Graceful quit with unreachable gateway
- **WHEN** Quit cannot contact the router to remove the mapping
- **THEN** cleanup ends within a bounded deadline, the app exits after its data-safety checks, and the lease expires without renewal

### Requirement: Honest connectivity diagnostics
The desktop SHALL expose mapping state separately from each peer's selected transport. It SHALL distinguish disabled, discovering, mapped, renewing, unsupported and failed mapping states, and direct WebRTC, TURN, application relay, connecting and disconnected peer states. Diagnostics SHALL omit credentials, project content and private key material.

#### Scenario: Mapped but using relay
- **WHEN** the router has a valid mapping but a peer's working connection uses TURN
- **THEN** the UI reports both facts and does not label that peer as directly connected

#### Scenario: Mapped but using the application relay
- **WHEN** the router has a valid mapping but a peer's working connection uses the server application relay
- **THEN** the UI reports the application relay route separately from UPnP success and exposes any relay limit

#### Scenario: Mapping recovery while relaying
- **WHEN** discovery, renewal or removal of a mapping fails during a healthy application relay session
- **THEN** that failure does not disconnect the relay or discard its pending work

#### Scenario: Nothing can connect
- **WHEN** mapping, ordinary direct paths and relay connectivity all fail
- **THEN** edits remain local, status explains that peers are unreachable, and bounded automatic recovery continues

