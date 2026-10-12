# Vendored dependency patches

## webrtc-ice 0.13.0: mapped endpoints on the UDP mux

| | |
| --- | --- |
| Upstream | `webrtc-ice` 0.13.0 from crates.io (part of [webrtc-rs](https://github.com/webrtc-rs/webrtc), MIT OR Apache-2.0) |
| Upstream archive SHA-256 | `eb51bde0d790f109a15bfe4d04f1b56fb51d567da231643cb3f21bb74d678997` (`webrtc-ice-0.13.0.crate`) |
| Wired in | `[patch.crates-io] webrtc-ice = { path = "vendor/webrtc-ice" }` in `apps/desktop/src-tauri/Cargo.toml` |
| Exact change | [`webrtc-ice-0.13.0-hivetex.patch`](webrtc-ice-0.13.0-hivetex.patch) (unified diff against the published crate) |
| Used by | `src/transport.rs` (shared, generation-scoped listener) and `src/rtc.rs` (`create_with(.., muxed: true)`) |

### Why

Desktop peer connections share one UDP socket per network generation (`UDPNetwork::Muxed`), so a router port mapping
can point at the socket ICE actually uses. The published crate has two gaps for that:

1. A muxed agent gathers only mux host candidates. It skips STUN, and every host candidate gets the mux socket's port
   even for the other address family.
2. There is no way to announce a verified external endpoint of the mux socket. `set_nat_1to1_ips` with Host
   replaces the private host addresses. With Srflx it cannot be combined with STUN and gathers on another socket.
   Editing the outgoing SDP would advertise an address that no local candidate (and no ICE check) is bound to.

### What the patch does

Two trait methods are added to `UDPMux`. Both have default implementations, so existing implementors (`UDPMuxDefault`)
and callers keep the upstream behaviour unchanged:

- `mapped_endpoints() -> Vec<(external, internal)>`: each pair whose internal port is the mux socket's port is
  gathered as a **server-reflexive candidate backed by the mux connection itself** (same ufrag routing, same socket),
  with the internal endpoint as related address. Pairs for another port or address family are ignored with a warning.
- `keeps_ordinary_gathering() -> bool`: when true, a muxed agent also runs ordinary STUN gathering on ephemeral
  sockets and gathers ephemeral host candidates for the address family the mux socket does not serve (IPv6 next to
  an IPv4 mux). TURN gathering is unaffected by the mux in either case.

`gather_candidates_local_udp_mux` now reports which family it served so the caller can complete the other one. No
other code path changes. HiveTeX's `SharedMux` returns `true` and the verified mapping of its own generation.

### Tests

Upstreamable regression tests live in the patched crate (`src/agent/agent_mapped_test.rs`, virtual network, no real
sockets):

| Test | Proves |
| --- | --- |
| `mapped_endpoint_is_gathered_on_the_mux_socket_next_to_host_and_stun` | host on the mux port, mapped srflx with the exact public address/port and related port, and ordinary STUN srflx on another port all present |
| `mapped_candidate_carries_traffic_when_nothing_else_can` | A sits behind a same-port 1:1 NAT and B behind a symmetric NAT, with no STUN or TURN. Without the mapping ICE fails and no packet reaches the public endpoint (negative control). With it ICE connects, packets are observed at the mapped public endpoint, and B's selected remote candidate is A's server-reflexive one |
| `default_mux_keeps_upstream_gathering` | a mux without the new methods still gathers only host candidates |
| `muxed_agent_still_connects_through_turn_only` | a muxed agent with relay-only candidate types connects through TURN (selected local candidate: relay) |

The whole crate suite passes with the patch: `cargo test --lib` in `vendor/webrtc-ice` gives 100 passed.

In the app crate (`cargo test --lib -- rtc:: transport::`):
- `listeners_are_shared_reference_counted_and_scoped_to_a_generation`
- `mappings_are_accepted_only_for_the_current_listener_and_withdrawn_on_network_change`
- `muxed_connections_share_one_listener_and_survive_each_others_close`
- `verified_mapping_is_offered_by_new_negotiations_only_while_published`
- `muxed_gathering_keeps_ipv6_host_candidates_where_the_machine_has_them` (same IPv6 host set as ordinary gathering)
- `lockfile_pins_the_vendored_patched_ice`: `Cargo.lock` resolves `webrtc-ice 0.13.0` to the path source, not the
  registry.

A build without the patch does not compile: `transport.rs` implements the two new trait methods.

### Updating or dropping the patch

Do not upgrade the transport stack opportunistically. To move to a newer webrtc-rs:
1. Re-apply the patch to the new `webrtc-ice` sources and regenerate the `.patch` file (`diff -ruN` against the
   published crate).
2. Rerun the crate's suite and the app's `rtc::`/`transport::` tests, then the desktop e2e suite.

Upstream disposition: not yet proposed. The change is additive and default-off, so it is suitable as an upstream pull
request with the vnet tests above. If upstream accepts an equivalent API, drop `[patch.crates-io]` and this
directory.
