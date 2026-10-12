# Router port mapping (UPnP) on the desktop app

When co-authors cannot reach each other directly, the desktop app can ask your home router to forward one UDP port
to it. Co-authors then get one more address to try. This is optional: without it the app still connects directly
where it can, otherwise through a TURN server or the encrypted HiveTeX relay.

## Controls

- **On by default** while a signed-in account is actively syncing a project on this computer.
- **Off** when you switch it off (Background syncing settings), in local mode, signed out, with **Work offline**, when
  no project is syncing, and when you quit. Turning it off removes the mapping within three seconds.
- **One mapping per computer**, shared by every project, not one per file or per co-author.

The status line says what the mapping is doing: off, looking for the router, active, renewing, not available (with
the reason) or failed. **Active means "offered to co-authors", never "connected"**. How each co-author is actually
connected (directly, through a TURN server, or through the HiveTeX server) is shown separately in People. It comes
from the connection that was actually selected.

## What the app does on the router

1. It looks for the router (UPnP Internet Gateway Device) only on the network interface of your default route.
   It accepts answers only from that route's gateway address.
2. It asks for the same UDP port that its peer-to-peer socket uses, with a **30-minute lease**. The description reads
   `HiveTeX <installation token>`.
3. It reads the mapping back. The address is published to co-authors only if the router really keeps the mapping
   for this computer and port.
4. It renews halfway through the lease (with a little jitter), and checks the public address each time.
5. On a conflict (the port is already forwarded to another device), it tries at most three other ports. It never
   changes or deletes a mapping that is not its own.

If the app crashes or the computer loses power, the router drops the mapping by itself when the lease runs out (at
most 30 minutes).

## Troubleshooting

| What you see | Why | What to do |
| --- | --- | --- |
| *not available (no UPnP gateway found)* | The router has UPnP switched off, or does not support it. | Optional: enable UPnP IGD on the router. Everything else keeps working. |
| *not available (router only accepts permanent mappings)* | Some older routers refuse finite leases. The app does not create permanent mappings, which would outlive it after a crash. | Nothing; connections use STUN/TURN or the relay. A manual forward is possible but not required. |
| *not available (router has no public address …: double NAT or carrier-grade NAT)* | The router itself sits behind another router or behind your provider's NAT (CGNAT, 100.64.0.0/10). Mapping it would not make you reachable. | Nothing on the app side. With double NAT you can enable UPnP or bridge mode on the outer router. |
| *not available (ports already mapped by other devices)* | Four candidate ports were taken by other devices. | Free the ports on the router, or ignore it. |
| *failed (router did not keep the requested mapping)* | The router accepted the request but reports another internal address or port. The app does not trust or delete such an entry. | Update the router firmware, or switch the mapping off. |
| *failed (port taken over by another mapping)* | Another device replaced the forward during the session. | It is retried on the next network change or restart. |
| *failed (gateway unreachable …)* | The router stopped answering. The mapping is withdrawn after a few retries. | Usually temporary (router restart). It resumes after a network change. |
| *Active*, but People shows *connected through a TURN relay* or *through the HiveTeX server* | The mapping exists, but your co-author's network cannot use it, or a faster path won. | Normal. A mapping is only an offer. |
| *Active* on the LAN, yet a co-author on the same Wi-Fi uses the local address | Many routers cannot loop traffic back to their own public address (no hairpin). | Normal: on the same network the local address is used. |

**Host firewall.** The app does not change firewall rules. Windows may ask once whether HiveTeX may communicate on
private networks: allow it for direct connections. Third-party firewalls that block inbound UDP make a mapping
ineffective. Connections then fall back to TURN or the relay.

## Privacy

Router URLs from the network are accepted only on the gateway itself, as plain local `http://` addresses, with no
redirects or proxies, short deadlines and size limits. Router addresses received from co-authors are never contacted.
The public address appears in the connection offer sent to co-authors of your projects (like any other connection
address), never in the status text. Local diagnostics stay on this computer.

## Evidence

Every row above is exercised against the emulated router (`src-tauri/src/igd.rs` `emulated::Router`) or an in-memory
gateway:

| Case | Test (`cargo test --lib`) |
| --- | --- |
| no gateway, or a responder that is not the route's gateway | `igd::tests::no_gateway_or_an_off_route_responder_is_not_found_within_the_deadline` |
| off-network/named/credential URLs, wrong device type, oversized SSDP | `igd::tests::ssdp_replies_are_accepted_only_from_the_gateway_with_a_gateway_url` |
| malformed, oversized and redirected descriptions; control URL off the gateway; DOCTYPE | `igd::tests::descriptions_resolve_the_wan_service_on_the_gateway_only`, `igd::tests::talks_to_an_emulated_router_and_refuses_redirects_and_oversized_descriptions` |
| permanent-only router, CGNAT, double NAT, router keeping another tuple | `portmap::tests::permanent_only_double_nat_and_ineffective_routers_are_not_used` |
| third-party mapping untouched on conflict and cleanup | `portmap::tests::same_port_mapping_against_the_emulated_router_keeps_third_party_mappings` |
| at most three alternative ports; unreachable gateway withdraws after bounded retries | `portmap::tests::conflicts_try_at_most_three_new_listener_ports_and_an_unreachable_gateway_withdraws` |
| renewals over hours, gateway reset, public-address change, 3 s cleanup, no late reactivation | `portmap::tests::mapper_publishes_renews_survives_a_gateway_reset_and_cleans_up_within_the_deadline` |
| disable while AddPortMapping is in flight | `portmap::tests::a_late_add_after_disable_is_compensated_and_never_published` |
| network change remaps the new listener and removes the old mapping | `portmap::tests::a_network_change_restarts_mapping_for_the_new_listener_only` |
| ICE does not wait for the router | `rtc::tests::negotiation_does_not_wait_for_a_slow_router_and_publishes_nothing_unverified` |
| mapped traffic with TURN disabled; the mapped candidate is what makes it connect | `agent_mapped_test` in `vendor/webrtc-ice` (see `vendor/PATCHES.md`) |
| status never implies a connection | `apps/web/test/sync-view.test.ts` › router port mapping status |
