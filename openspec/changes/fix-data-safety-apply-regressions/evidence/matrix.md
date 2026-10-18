# Transport matrix (task 9.3, 8.5)

`MATRIX=stun,turn,relay,relay-stun,deaf,no-udp HOLD_S=300`, local server, Windows Sandbox ↔ host on one PC
(Hyper-V NAT, not a real NAT). TURN credentials from `.env.setup`, `NO_APP_RELAY=0`. The first run
(2026-10-18 00:42–01:00) was stopped by Claude Code's memory guard after `relay`; the remaining three scenarios ran
on their own at 06:04–06:23 (`matrix-part2.txt`, printed by the harness). Run folders: `runs/<timestamp>-<scenario>`.

| scenario   | result | route | sync ≤ 5 s (host→sandbox / sandbox→host) | hold: late/edits, median | socket rotation |
|------------|--------|-------|-------------------------------------------|--------------------------|-----------------|
| stun       | FAIL (expected) | none: ICE `checks-failed` | – | – | – |
| turn       | PASS   | turn  | yes, 169 / 156 ms | 0/60, 236 ms | ok, 0 late after |
| relay      | PASS   | relay | yes, 72 / 47 ms   | 0/60, 74 ms  | ok, 0 late after |
| relay-stun | PASS   | relay | yes, 80 / 51 ms   | 0/60, 59 ms  | ok |
| deaf       | PASS   | relay | yes, 60 / 53 ms   | 0/60, 82 ms  | ok |
| no-udp     | PASS   | relay | yes, 62 / 46 ms   | 0/60, 64 ms  | ok |

No scenario was skipped for missing credentials. `stun` fails because between the sandbox and the host no direct
UDP pair forms without a relay (see `docs/testing.md`); this is the environment, not a regression.

`no-udp` (task 8.2): the sandbox firewall stays on with an outbound UDP block on the app's exact path, checked in
`ActiveStore` before the run (`runs/…-no-udp/sandbox-setup.txt`, `firewall-end.txt`); setup throws if the profiles
are off or the rule is not in effect. The link used the application relay with no UDP pair.
