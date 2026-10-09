# Tasks

## 1. Native compile hardening (desktop)

- [x] 1.1 Pass `-norc` to latexmk and skip `latexmkrc`/`.latexmkrc` when writing the build directory (`tex.rs`); verify a new Rust test where a project `.latexmkrc` tries to create a marker file and the marker never appears, and existing tex tests still pass with `cargo test --lib`
- [x] 1.2 Set `MIKTEX_CORE_ALLOWUNSAFEINPUTFILES=f` / `MIKTEX_CORE_ALLOWUNSAFEOUTPUTFILES=f` in `base_command`; verify new Rust tests that `\input` of an absolute path and of `../` to a file containing `\errmessage{LEAKED}` never put `LEAKED` in the log (run locally on MiKTeX 25.4 and in the Desktop workflow on all three OSes)
- [x] 1.3 Update the "Compile isolation" section of `docs/compilation.md` and `docs/security.md`; verify the documented protections match the tests

## 2. GitHub OAuth and backup binding

- [x] 2.1 Server: `/github/callback` redirects to `#/github-continue?code&state` without exchanging; new `POST /github/complete` exchanges only when the session user equals the state's user; verify server tests: same user completes, a different user is rejected and the state is consumed, missing session is 401
- [x] 2.2 Web: `github-continue` route (sign-in if needed, then complete, then show result) and adapt `lib/github.ts`; verify the existing `e2e/github.spec.ts` flows still pass and a new e2e where another account completes a forwarded link gets an error
- [x] 2.3 Backup authority: ticket endpoint returns `githubRepo`; `BackupAgent` takes `authorizedRepo()` and refuses to push on mismatch with status `binding-mismatch`; verify `packages/github` tests: an editor-written meta binding to another repo causes no push and the status reports the mismatch
- [x] 2.4 Document the new linking flow in `docs/github-backup.md`; verify the steps match the UI

## 3. Membership and peer protocol

- [x] 3.1 Reject ticket refreshes older than the current ticket (`ep`/`iat`) and keep peers stale while `ep < maxEpoch`; verify a sync test reproducing demote → viewer ticket → replay old editor ticket: updates are dropped and the replay closes the connection
- [x] 3.2 Global join failure limit per account and per IP across project IDs; verify a server test where 21 failures over different slugs block the next join attempt even for a new slug
- [x] 3.3 Signaling challenge/response (server nonce, Ed25519 signature with the device key, verification against `claims.devE`); update `ConnectionManager`; verify server signal tests: copied ticket without the key is refused and causes no presence/leave, honest client still connects; sync handshake tests still pass
- [x] 3.4 `MAX_BLOB_BYTES` in protocol; blob receiver ignores oversized transfers; verify a sync test with a peer advertising a huge chunk count: fetch falls back to an honest peer and memory is not allocated for the bogus total
- [x] 3.5 Throttle compile requests per peer (5 s) and re-send the last result when the state is unchanged; verify compile pipeline tests: 200 requests in 1 s cause at most one build, unchanged state causes no build

## 4. Desktop folder picking

- [x] 4.1 Rust `mirror_pick` with persisted allowlist; `mirror_bind` refuses paths not picked through it; verify Rust tests for allowlist acceptance/refusal and canonicalization, and `cargo test --lib` passes
- [ ] 4.2 Web: use `mirror_pick` for "Link folder…" and desktop folder import; remembered folders not in the allowlist ask the user to pick again; verify `svelte-check`, web unit tests, and a manual `make desktop-dev` check of link folder + folder import

## 5. Integration

- [x] 5.1 Run `make check` and the Desktop workflow on a pushed branch; verify both are green and the new security tests ran on Windows, macOS and Linux
