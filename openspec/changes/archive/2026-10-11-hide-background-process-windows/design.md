# Design

## Context

Only the desktop app (Tauri, `apps/desktop/src-tauri`) starts other programs. The web app and the server never show
a window, so they are out of scope. The release build already uses `windows_subsystem = "windows"` (`src/main.rs`),
so the app itself has no console. The flashes come from the console programs it starts. A Windows console program
started from a GUI process gets a **new, visible console** unless it is created with `CREATE_NO_WINDOW`
(`0x0800_0000`).

Process launches found in the code today:

| Where | Program | When | Hidden today? |
|---|---|---|---|
| `tex.rs` `version_text` | `pdflatex --version` | `tex_detect` (project open) and the start of every compile | no |
| `tex.rs` `roots_from` | `kpsewhich -var-value=…` ×11 | first build check per session (`OnceLock`) | no |
| `tex.rs` `run_limited_io` | latexmk / engine / tectonic | every compile | yes (`CREATE_NO_WINDOW`) |
| `tinytex.rs` `tlmgr_runner` | `tlmgr.bat` → cmd → perl | missing package, managed TinyTeX | no |
| `managed.rs` SevenZipSfx | `TinyTeX-1-windows-*.exe -y -o…` | installing full LaTeX | no (it is a GUI extractor) |
| `terminal.rs` `open` | `wt.exe` / `cmd.exe /K` | Open in terminal | intentionally visible |
| `tauri_plugin_opener` | shell open / reveal | Open folder / reveal | intentionally visible |

Re-checked against `master` at `aad3a34` (after merging `feat/harden-realtime-peer-sync`): the launch sites above are
unchanged. The web side calls `tex_detect` from `NativeEngine.init()` (`session.svelte.ts` `loadEngine`, once per project
open and after a quick-compiler install) and from `CompilerPanel.svelte` `refresh()`. Compiles that the desktop helper
runs for the browser go through the same `compile_with`, so they benefit from the cache too. The dev build's console
hides the problem: children attach to it. The flashes only show in release builds.

Children inherit the hidden console of a `CREATE_NO_WINDOW` parent: latexmk → engine, cmd → perl. So hiding the
top-level launch is enough for those trees.

## Goals / Non-Goals

**Goals:**
- One shared way to build a background `Command`, so every current and future launch is hidden.
- A test that catches a new raw `Command::new` added outside that shared code.
- Fewer process launches per save (cached detection).

**Non-Goals:**
- Changing what Open in terminal or the opener plugin do.
- The dev build's own console (`debug_assertions`). Only developers see it.
- E2E/dev scripts under `apps/desktop/e2e` and `scripts/`. They are developer tooling, not user-facing.

## Decisions

### 1. A shared `background_command(program)` helper (new module `src/proc.rs`)
It returns a `std::process::Command` with `stdin(Stdio::null())`. On Windows it also sets
`creation_flags(CREATE_NO_WINDOW)`. On Unix it changes nothing: a console program started from a GUI app never opens
a terminal there. `run_limited_io` keeps its own `setsid`/rlimit `pre_exec` and its Job object. It now gets its base
`Command` from the helper and drops its inline `0x0800_0000`. `version_text`, `roots_from`, `tlmgr_runner` and
`base_command` switch to the helper.
*Alternative considered:* adding `creation_flags` at each call site. It is what caused this bug, so it is rejected.

### 2. A guard test scans the sources
A unit test reads every `src/**/*.rs` file and fails if `Command::new(` appears anywhere other than `proc.rs` and
`terminal.rs`, and outside `#[cfg(test)]` code. It is crude, but it costs nothing and catches the exact regression.
*Alternative considered:* a clippy `disallowed_methods` rule for `std::process::Command::new` with `#[allow]` in the
two allowed files. That is stronger, but it only runs when clippy runs. Clippy can be added later on top of the test.

### 3. Cache detection, with explicit invalidation
Keep the last `EngineInfo` in a `Mutex<Option<EngineInfo>>` in `tex.rs`:
- `compile_with` uses the cached value and runs `detect()` only when the cache is empty.
- `tex_detect` (the command the UI calls) always re-detects and refreshes the cache. The panel's "check again" and
  project open stay accurate, and it is one hidden launch.
- `managed_install` and `managed_remove` clear the cache.
- A cached engine is reused only while its executable still exists (a file check, no process); otherwise the compile
  detects again. "Nothing found" is never cached, so a TeX installed meanwhile is found by the next compile.

*Alternative considered:* no cache, only hiding. That fixes the visible problem but still costs about 100 ms of process
launches per save. Caching is small and makes saves cheaper.

### 4. Unpack the TinyTeX SFX without its GUI
The Windows TinyTeX asset is a 7-Zip GUI SFX. `CREATE_NO_WINDOW` does not hide GUI windows. Plan: find the 7z
signature (`7z\xBC\xAF\x27\x1C`) inside the `.exe` and extract that archive in-process with a pure-Rust 7z crate
(`sevenz-rust2`). The SHA-256 of the whole file is still checked before unpacking, as today.
*Fallback:* if the crate cannot read the payload (an unsupported codec such as BCJ2), launch the SFX through
`CreateProcessW` with `STARTUPINFO.wShowWindow = SW_HIDE` (`STARTF_USESHOWWINDOW`) instead of `std::process`. That
needs the `Win32_System_Threading` feature, which is already enabled. The task list checks the crate first.
*Outcome:* the crate reads the payload (task 3.1), so the fallback is not needed. The dependency is a normal one, not a
`cfg(windows)` one, so the extraction tests also run on the Linux and macOS CI.

## Risks / Trade-offs

- [tlmgr's Windows self-update starts a separate detached process after tlmgr exits (see `tinytex.rs` comment),
  which may open its own console] → Verify by hand on Windows with an outdated TinyTeX. If it does, run the self-update
  step ourselves through the hidden helper instead of letting tlmgr spawn it. Note the result in the task.
  *Outcome:* no window appears (task 4.2). The check found an older bug: `tlmgr.bat` exits 0 when tlmgr stops with
  "tlmgr itself needs to be updated", so the self-update never ran and the package was reported as installed. A
  reported stop (`… : Terminating`) now counts as a failure (`tinytex::outcome`).
- [A cached `EngineInfo` is stale if the user installs or removes a system TeX while the app runs] → The compiler
  panel re-detects whenever it is opened, and a cached engine whose executable is gone is detected again (Decision 3).
- [The source-scan test can give false positives, for example `Command::new` inside a comment or doc string] → It
  matches code lines only (it skips `//` lines). The allow-list is easy to extend with a comment explaining why.
- [A new crate adds supply-chain surface] → Pure Rust, exact pinned version (`=0.23.0`, default features off, `util`
  only). The SHA-256 check before unpacking is unchanged, and the crate refuses entries outside the target folder.

## Migration Plan

Nothing to migrate. Ship in the next desktop release. Rollback means reverting the commit. No data or format changes.
