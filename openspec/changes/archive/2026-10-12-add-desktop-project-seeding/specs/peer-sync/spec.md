# Spec Delta

## MODIFIED Requirements

### Requirement: Content never touches the control plane
Document sources, binary assets, compiled PDFs and edit operations MUST travel only between member devices (directly or through an encrypted relay that cannot decrypt them) and MUST NOT be stored on or readable by the control plane. A relay co-hosted on the same infrastructure SHALL forward only transient ciphertext, without retaining content payloads in databases, caches or logs.

#### Scenario: Control plane inspection
- **WHEN** an operator inspects the control plane database, caches and logs during an active editing session
- **THEN** no document text, file names inside the project, assets or PDFs are present

#### Scenario: Co-hosted relay inspection
- **WHEN** devices exchange project data through the server's relay role
- **THEN** only routing metadata and transient ciphertext are available to that role, and no payload archive or plaintext content is stored

#### Scenario: All source devices offline
- **WHEN** no authorized device holding the project is available
- **THEN** the application relay cannot bootstrap a new member from server storage and the existing no-source status applies

### Requirement: NAT traversal fallback
When a direct connection cannot be established, capable clients SHALL use configured TURN when it works and otherwise an end-to-end encrypted application relay on the existing server when the deployment enables it, it is reachable and within budget, without requiring a separately configured TURN provider. The application relay SHALL be a last resort and disabled unless the deployment enables it. Desktop automatic port mapping SHALL supplement direct connectivity without blocking either relay path.

#### Scenario: Symmetric NAT
- **WHEN** two peers cannot connect directly
- **THEN** they connect through the relay and sync continues, with content still end-to-end encrypted

#### Scenario: UPnP mapping fails
- **WHEN** automatic port mapping is unavailable, rejected or ineffective
- **THEN** the peers can still establish an ordinary direct connection or use configured TURN or the application relay without manual port configuration

### Requirement: Initial sync for new members
A new member device SHALL receive the full current project state from an online peer authorized to supply it, including a desktop background seed, and SHALL show its progress while it does. Viewer-only availability SHALL NOT be treated as an authoritative bootstrap source.

#### Scenario: No peer online
- **WHEN** a new member opens a project and no other member device is online
- **THEN** the UI states that no peer is online and offers bootstrap from the linked GitHub backup if one exists and the user has access to it

#### Scenario: Slow initial sync
- **WHEN** a new member joins and the transfer takes minutes
- **THEN** the member sees the stage and progress throughout, and never an "all synced" message while files are missing

#### Scenario: Only a background seed is online
- **WHEN** a new member opens a project whose only available source is a complete owner/editor desktop seed
- **THEN** initial sync completes from that seed without its editor being opened

#### Scenario: Only viewers are online
- **WHEN** a new member has no project content and only viewers are connected
- **THEN** the UI explains that an owner/editor source is required and does not claim successful bootstrap

### Requirement: Connection lifecycle isolation
Only one current connection attempt per remote device SHALL own its negotiation state. Pausing or stopping project synchronization SHALL cancel pending setup and prevent delayed callbacks from opening connections or restarting work. Detaching a desktop workspace SHALL retain an enabled seed session. Delayed callbacks from older attempts and signaling sessions SHALL NOT replace or invalidate newer ones.

#### Scenario: Duplicate discovery during setup
- **WHEN** signaling and peer exchange announce the same device while connection configuration is loading
- **THEN** they share one current attempt and no orphan connection is created

#### Scenario: Stop during setup
- **WHEN** the member pauses synchronization while setup awaits configuration
- **THEN** later completion of that configuration does not create a connection or transmit signaling

#### Scenario: Desktop workspace detachment
- **WHEN** a desktop member navigates away from an enabled seed project
- **THEN** its connection ownership stays with the background session and a late UI callback cannot destroy it

#### Scenario: Browser workspace closure
- **WHEN** a browser member closes a project workspace
- **THEN** its in-page session stops and delayed setup cannot reopen its connections

## ADDED Requirements

### Requirement: Background seed availability
Peers SHALL distinguish background device availability from an attached editor's cursor and viewed file. Detaching the last editor SHALL clear its cursor and viewed-file presence while retaining authenticated seed availability for connected peers. A dormant seed SHALL be reachable through the doorbell rather than through continuous server presence. Presence extensions SHALL interoperate with peers that do not understand seeding status.

#### Scenario: Person leaves the editor
- **WHEN** a member closes a workspace but its desktop seed stays online
- **THEN** updated peers show background availability without a stale cursor or a claim that the person is editing a file

#### Scenario: Dormant seed is needed
- **WHEN** a member opens a project whose only source is a dormant desktop seed
- **THEN** the member's client rings the project and the seed comes online and supplies the project without its editor being opened

#### Scenario: Older peer
- **WHEN** an existing supported browser or desktop version connects to a new seed
- **THEN** document synchronization still works, unknown optional presence fields are ignored and the application relay is used only after capability negotiation

### Requirement: Application relay session authentication
Before project data crosses the application relay, peers SHALL verify current same-project membership and possession of the ticket's device key, bound to a fresh encrypted session. Relay keys SHALL be separated from signaling keys. Forged, reflected, replayed or wrong-context traffic SHALL be rejected. Ticket expiry, revocation and viewer restrictions SHALL apply as on WebRTC.

#### Scenario: Replayed encrypted traffic
- **WHEN** a previously delivered encrypted frame is replayed in the same session or after reconnect
- **THEN** it cannot apply an edit again or authenticate a replacement session

#### Scenario: Session or recipient substitution
- **WHEN** an intermediary changes a handshake identity, channel context, recipient or session binding
- **THEN** authentication fails before any project content is exchanged

#### Scenario: Permission changes during relay use
- **WHEN** a relay-connected editor is demoted or their ticket expires
- **THEN** current authorization is enforced and buffered work cannot regain the earlier permissions

### Requirement: Bounded reliable application relay delivery
Application relay delivery SHALL tolerate transient loss, duplication and reordering with bounded buffers and retry. Server acceptance SHALL NOT establish peer receipt, local durability or synchronization completion. When delivery cannot recover, the link SHALL fail visibly and reconcile from member-held state after reconnection.

#### Scenario: Publish succeeds but recipient misses it
- **WHEN** the server accepts ciphertext but the recipient's subscription drops before receipt
- **THEN** the sender retries within its limits or reports pending delivery without claiming synchronization

#### Scenario: WebSocket lifetime expires
- **WHEN** a hosting duration limit closes the signaling socket during a relay transfer
- **THEN** the clients reconnect, establish fresh authorization and encryption, and reconcile missing work without reopening the project

#### Scenario: Relay backpressure
- **WHEN** a receiver or cross-instance backend cannot keep up
- **THEN** queues remain bounded, control traffic is protected and stalled sends terminate or remain explicitly pending

### Requirement: Safe transport selection
Clients SHALL prefer a healthy direct connection, then configured TURN, and attempt the application relay when connection setup fails or exceeds a bounded deadline. UPnP and optional TURN configuration SHALL NOT be prerequisites for this fallback. A later transport switch SHALL preserve edits and current authorization with one authoritative peer connection generation.

#### Scenario: Direct and TURN unavailable
- **WHEN** two capable peers can reach the application server but direct WebRTC and TURN are unavailable
- **THEN** they attempt authenticated application relay setup within 10 seconds of learning each other's available relay capability

#### Scenario: Direct connectivity recovers
- **WHEN** a working direct path becomes available while peers use the application relay
- **THEN** a coordinated authenticated handover resumes synchronization without lost edits, duplicate active ownership or stale callbacks

#### Scenario: Relay unavailable too
- **WHEN** direct, TURN and application relay paths cannot connect
- **THEN** the app preserves local edits, reports unavailability and retries with bounded backoff rather than promising guaranteed connectivity

### Requirement: Zero idle control-plane cost
A device with no connected peer need and no introduction in progress SHALL hold no connection to the control plane and SHALL send no presence heartbeats, ticket renewals or polling requests. Signaling sockets SHALL exist only while an introduction is in progress or an application-relay session needs them, and SHALL close once the wanted links are authenticated or the introduction window ends. Connected peers SHALL keep exchanging edits without the control plane.

#### Scenario: Idle seed overnight
- **WHEN** a desktop seed has no peer and nobody rings its projects for hours
- **THEN** it makes no request to the control plane and holds no signaling socket during that time

#### Scenario: Editing with connected peers
- **WHEN** members are connected to each other and edit
- **THEN** no device keeps a gatekeeper socket open and edits do not use the control plane

### Requirement: Doorbell wake-up
Members SHALL reach devices that are not connected by publishing a short-lived ring token, signed by the control plane after a membership check, to a per-project ring topic on a push channel the devices subscribe to. Ring topics SHALL change with the membership epoch and SHALL not reveal project or user identifiers. Ring requests SHALL be rate-limited.

#### Scenario: Newcomer wakes a dormant seed
- **WHEN** a new member opens a project whose only owner/editor device is a dormant desktop seed
- **THEN** the seed is woken, introduced through the control plane and the member's initial sync proceeds

#### Scenario: Removed member rings
- **WHEN** a member removed from the project publishes to the ring topic it knew before
- **THEN** the topic is no longer subscribed after the epoch change and no device wakes

#### Scenario: Ring answered by a mesh
- **WHEN** several connected members receive the same ring
- **THEN** one representative of their mesh answers and the others are reached through peer exchange

#### Scenario: Push channel unavailable
- **WHEN** a device cannot subscribe to the push channel
- **THEN** its status says the project is reachable only while open, its established links and editing continue, and subscription retries are bounded

### Requirement: Ring token verification
Devices SHALL verify ring tokens offline and SHALL ignore forged, expired, replayed, wrong-topic or older-epoch tokens without network activity. Wake-ups SHALL be rate-limited per device. Ring tokens SHALL NOT grant any project access: woken peers authenticate with tickets and device keys as before.

#### Scenario: Replayed ring
- **WHEN** a previously published ring token is delivered again or after its expiry
- **THEN** no device opens a connection because of it

#### Scenario: Forged ring
- **WHEN** a ring message is not signed by the control plane or names another topic or an older epoch
- **THEN** the device ignores it without contacting the control plane

### Requirement: Application relay budgets
The server SHALL enforce aggregate and per-principal limits on relay bytes, messages, connections, connection time and queued work before forwarding. Text and control traffic SHALL take priority over bulk transfers within those limits. Assets exceeding available budget SHALL remain pending. Quota errors SHALL identify the retry condition without terminating unrelated healthy direct links.

#### Scenario: Asset consumes remaining budget
- **WHEN** a binary transfer would exhaust its allowed relay budget
- **THEN** bulk transfer is deferred, local work stays intact and the UI distinguishes missing content from received text

#### Scenario: Several accounts or instances compete
- **WHEN** many authenticated sessions on different server instances send relay traffic
- **THEN** they cannot bypass the deployment budget by reconnecting, changing projects or opening more connections

#### Scenario: Cost accounting unavailable
- **WHEN** the relay cannot obtain a valid forwarding budget
- **THEN** it refuses new application payload forwarding, exposes the failure and preserves ordinary direct synchronization

### Requirement: Additive relay capability negotiation
Application relay support SHALL be negotiated between the server and both peers. Existing peers and servers that do not support it SHALL retain their WebRTC behavior. Unknown capability announcements SHALL NOT be treated as proof of a usable or authenticated relay connection.

#### Scenario: Older peer or server
- **WHEN** one participant or the server lacks the relay capability
- **THEN** clients continue existing direct or configured TURN attempts and report fallback unavailable without sending unsupported mandatory messages

### Requirement: Relay route and progress visibility
Clients SHALL distinguish direct WebRTC, TURN and application relay routes, including a relay-limited state. Router mapping status SHALL remain separate. Content availability, local durability and current peer reconciliation SHALL remain independently reported for every route.

#### Scenario: Text received while image is deferred
- **WHEN** text has reconciled but an image awaits relay budget
- **THEN** the project remains incomplete, the image has a visible pending reason and no full-project sync completion is claimed
