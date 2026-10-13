# Desktop sync worker: process and protocol

The desktop app runs synchronization in a **headless worker**: the pinned Node runtime shipped with the app
(`apps/desktop/worker.config.json`) running one bundled script (`apps/desktop/worker-build.mjs` →
`resources/worker/hivetex-worker.mjs`). The Rust side (`src-tauri/src/worker.rs`) is its supervisor.

## Process rules

- **One fixed program.** The node executable and the script come from the app's resources; no path, argument or
  environment value comes from the network or a web page.
- **Hidden, clean start.** Launched through `proc::background_command` (no console window). The environment is
  cleared except for a few OS variables (`SystemRoot`, `TEMP`, `HOME`, `APPDATA`, ...): `NODE_OPTIONS`, `NODE_PATH` and
  every other variable that could inject code are dropped. The only thing passed in is `HIVETEX_WORKER_GEN`.
- **Pipes only.** The worker talks over its stdin/stdout; there is no localhost server, no shell and no generic file
  access. stderr carries redacted diagnostics.
- **Never outlives the app.** The worker exits when stdin closes. On Windows it runs in a kill-on-close job object;
  on Linux it gets `PR_SET_PDEATHSIG`; so even a killed app leaves no worker announcing the device.
- **Restarts.** After a crash the supervisor starts a new generation after 1 s, doubling up to 30 s (with jitter).
  More than five crashes within ten minutes stop the restarts and the app shows *needs attention*.

## Framing

Each message is a 4-byte big-endian length followed by that many bytes of UTF-8 JSON, at most 8 MiB
(`MAX_FRAME`). An oversized length or a body that is not JSON is fatal for the stream: the reader closes it and the
supervisor starts a fresh generation.

Every message has `v` (protocol version, `1`) and `gen` (the worker generation). A message with another version is
rejected; a message of another generation is dropped without being acted on.

```json
{ "v": 1, "gen": 4, "kind": "evt", "event": "ready", "data": { "protocol": 1, "gen": 4 } }
```

```json
{ "v": 1, "gen": 4, "kind": "req", "id": 17, "method": "hello" }
```

```json
{ "v": 1, "gen": 4, "kind": "res", "id": 17, "ok": true, "result": { "protocol": 1, "gen": 4, "node": "v22.22.0" } }
```

```json
{ "v": 1, "gen": 4, "kind": "res", "id": 18, "ok": false, "error": { "code": "unknown_method", "message": "unknown method fs.read" } }
```

```json
{ "v": 1, "gen": 4, "kind": "cancel", "id": 19 }
```

Requests carry an `id`; the answer repeats it. `cancel` aborts a running request: the handler stops and no response
is sent. An unknown method gets an `unknown_method` error.

## What the worker may ask of the native side

The native dispatcher accepts only the methods in `worker::WORKER_METHODS`: the project store (`store.*`), native
RTC (`rtc.*`), reading the device's own secrets (`secret.get`) and status reports. Anything else (a shell, files,
compiler, folder mirror, writing secrets) is refused with `unknown_method`.

Native RTC connections of the worker are keyed `w<gen>/<project>/<connection>`
(`src-tauri/src/worker_bridge.rs`): two projects connected to the same remote device never share a connection, and
after a restart every connection of the old generation is closed and its late events are dropped. Events wait in a
bounded queue (1,024); a connection whose events overflow it is closed rather than buffered without limit.

## Diagnostics

Worker logs go through `redactDiagnostics` (`packages/sync/src/worker-ipc.ts`): JWS tokens (tickets, ring tokens,
session tokens), bearer headers, long base64 and hex strings (keys, ciphertext) and push topic URLs are replaced
before anything is written. Project content is never logged.

Tests: `packages/sync/test/worker-ipc.test.ts` (codec, RPC, the real bundled worker under Node, these documented
examples), `cargo test --lib worker::` and `worker_bridge::` in `apps/desktop/src-tauri`.
