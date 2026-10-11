# Proposal

## Why

On Windows, the desktop app flashes console windows when a project opens and on every Ctrl+S. They appear for an
instant, steal attention and sometimes keyboard focus, and look like something went wrong. The app starts several
helper programs (TeX version checks, `kpsewhich`, `tlmgr`, the TinyTeX installer), and most of them are launched
without asking Windows to hide their window. Only the compile itself (`run_limited_io` in `apps/desktop/src-tauri/src/tex.rs`)
sets `CREATE_NO_WINDOW` today.

What we found in the code:

- `tex::detect()` runs `pdflatex --version` with no hidden-window flag. The web UI calls it when a project opens
  (`tex_detect`, from `packages/compile/src/native.ts` and `CompilerPanel.svelte`). `compile_with` also calls it at the
  start of **every** compile, so each Ctrl+S that triggers a build flashes a console.
- `roots_from()` runs `kpsewhich -var-value=…` up to 11 times (once per variable) the first time a build is checked
  for what it read: a burst of flashing windows on the first compile of a session.
- `tinytex::tlmgr_runner` runs `tlmgr.bat` (through `cmd.exe`) when the managed full LaTeX installs a missing package.
  The console stays visible for the whole install, which can take seconds.
- The managed TinyTeX install runs the 7-Zip self-extracting `.exe` directly, so the extractor's own window appears.

## What Changes

- Every helper program the desktop app starts on its own SHALL run without a visible window or taking focus, on
  every OS. On Windows this means the "no window" creation flag on every background launch, applied in one shared
  place so new launches cannot forget it.
- The only exception is **Open in terminal** (`terminal.rs`). The user asks for a terminal there, so it stays visible.
- TeX detection results are reused between compiles instead of re-running the version checks on every save. They are
  refreshed when the compiler set-up changes (managed install or removal) and when the compiler panel asks again.
- The TinyTeX Windows archive is unpacked without showing the self-extractor's window.
- A regression guard (a test) fails the build if a new process launch skips the shared helper.

No user-facing feature is added or removed, and nothing breaks for users.

## Capabilities

### New Capabilities
- `background-processes`: helper programs the desktop app runs on the user's behalf (detection, compilation, package
  installation, unpacking) stay invisible and never take focus. Programs the user explicitly asks to open, such as a
  terminal, are the exception.

### Modified Capabilities
<!-- None: compiler-provisioning and distributed-compilation keep their requirements; how their programs are launched
     is covered by the new capability. -->

## Impact

- `apps/desktop/src-tauri/src/tex.rs`: `version_text`, `roots_from`, `run_limited_io`, `base_command`, and caching of
  `detect()`.
- `apps/desktop/src-tauri/src/tinytex.rs`: `tlmgr_runner`.
- `apps/desktop/src-tauri/src/managed.rs`: unpacking the `SevenZipSfx` asset.
- New small module for the shared background-launch helper, plus a source-scanning test.
- Possibly one new Rust dependency, for unpacking 7z in-process (see design.md).
- No change to the web app, the server, the protocol, or `terminal.rs` behavior.
