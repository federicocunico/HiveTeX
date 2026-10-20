# Spec Delta

## MODIFIED Requirements

### Requirement: Bounded reliable application relay delivery
Application relay delivery SHALL tolerate transient loss, duplication and reordering with bounded buffers and retry. Server acceptance SHALL NOT establish peer receipt, local durability or synchronization completion. When delivery cannot recover, the link SHALL fail visibly and reconcile from member-held state after reconnection. Senders SHALL adapt how much they keep in flight and when they retransmit to the loss and delay they observe, so overload slows delivery instead of multiplying it.

#### Scenario: Publish succeeds but recipient misses it
- **WHEN** the server accepts ciphertext but the recipient's subscription drops before receipt
- **THEN** the sender retries within its limits or reports pending delivery without claiming synchronization

#### Scenario: WebSocket lifetime expires
- **WHEN** a hosting duration limit closes the signaling socket during a relay transfer
- **THEN** the clients reconnect, establish fresh authorization and encryption, and reconcile missing work without reopening the project

#### Scenario: Relay backpressure
- **WHEN** a receiver or cross-instance backend cannot keep up
- **THEN** queues remain bounded, control traffic is protected and stalled sends terminate or remain explicitly pending

#### Scenario: Receiver overload is a drop, not a forwarding limit
- **WHEN** the server drops frames addressed to a device because that device's delivery queue is full
- **THEN** the device is told that inbound frames were dropped, without a retry delay, and it keeps sending and retransmitting its own traffic as before

#### Scenario: Senders back off under loss
- **WHEN** frames a sender relayed go unacknowledged past its current timeout or the receiver reports inbound drops
- **THEN** the sender reduces the frames it keeps in flight towards that peer and grows them again only as acknowledgements arrive

#### Scenario: Retransmission timing follows the path
- **WHEN** acknowledgements over the relay arrive later than the default timeout because of queueing
- **THEN** the sender's retransmission timeout follows the measured round-trip time, so frames that are delayed but not lost are not resent

#### Scenario: Many peers start through the relay on a slow host
- **WHEN** twelve members of a project with no direct or TURN path start at the same time and each relay delivery is delayed by 15 ms
- **THEN** every member receives the existing text and later edits converge, without relying on a test retry, and retransmissions stay fewer than first sends
