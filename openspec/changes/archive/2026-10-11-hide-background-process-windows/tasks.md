# Tasks

## 1. Shared hidden-launch helper

- [x] 1.1 Add `apps/desktop/src-tauri/src/proc.rs` with `background_command(program) -> Command` (stdin null; on Windows `creation_flags(CREATE_NO_WINDOW)`), register it in `lib.rs`, and verify with a `#[cfg(windows)]` unit test that a console program started through it (`cmd /c exit 0`) succeeds, and with `cargo test proc` passing
- [x] 1.2 Switch `tex.rs` `version_text`, `roots_from` and `base_command` to `background_command`, and make `run_limited_io` drop its inline `0x0800_0000` flag while keeping the Unix `pre_exec` and the Windows Job object; verify `cargo test tex` passes (including the existing compile tests on a machine with TeX)
- [x] 1.3 Switch `tinytex.rs` `tlmgr_runner` to `background_command`; verify `cargo test tinytex` passes
- [x] 1.4 Add the guard test (in `proc.rs`): scan `src/**/*.rs` and fail on `Command::new(` in code lines outside `proc.rs` and `terminal.rs`; verify it passes now and fails if a raw `Command::new` is temporarily added to `tex.rs`

## 2. Detection cache

- [x] 2.1 Cache the last `EngineInfo` in `tex.rs` (`EngineCache`); `compile_with` uses it and calls `detect()` only when it is empty or its engine executable no longer exists; verify with a unit test (`saves_reuse_the_detected_engine`) that ten lookups through a counting detect function detect once
- [x] 2.2 Make `tex_detect` always refresh the cache, and make `managed_install` / `managed_remove` in `lib.rs` clear it; verify with a unit test that a compile after clearing re-detects

## 3. Hidden TinyTeX unpacking (Windows)

- [x] 3.1 Check whether `sevenz-rust2` can extract the 7z payload of the pinned `TinyTeX-1-windows-v2026.10.exe` (locate the 7z signature, open from that offset); record the result (codecs supported or not) in this task. Result: yes with `sevenz-rust2 =0.23.0` (`util` only, no extra codecs): signature at byte 194048, 8975 files in 6.8 s, the unpacked `pdflatex.exe --version` runs (TeX Live 2026). 0.24.0 was published on the day of the check, so the older 0.23.0 is pinned
- [x] 3.2 If 3.1 succeeds: add `sevenz-rust2` as a `cfg(windows)` dependency and replace the `SevenZipSfx` branch in `managed.rs` with in-process extraction (SHA-256 check unchanged); otherwise launch the SFX through `CreateProcessW` with `SW_HIDE`. Verify with a unit test that extracts a small SFX-shaped fixture (stub bytes + 7z archive), or with the existing managed install test on Windows

## 4. Verification on Windows

- [x] 4.1 Build the release desktop app (`windows_subsystem = "windows"`) and check by hand on Windows with system TeX Live or MiKTeX that opening a project, the first compile, and ten Ctrl+S compiles show no window and the editor keeps focus while typing; note the result here. Result (2026-10-11, Windows 11, MiKTeX): checked with a GUI-subsystem probe binary linked to the real library (like the release app: one detection, then three compiles), while a script listed every new visible top-level window (`EnumWindows`). Before the change: 30 new windows in about 9 s (15 Windows Terminal windows plus their pseudo-consoles). After: 0 windows, and all three compiles succeed. With no window there is nothing to take focus. A by-hand check in the full app was not done.
- [x] 4.2 With the managed full LaTeX, compile a document that needs a missing package (for example `\usepackage{tikz-cd}`) and check that no console appears during `tlmgr` and that the tlmgr self-update path (outdated TinyTeX) opens no window either; note the result here, and fix the self-update launch if it does open one (design.md, Risks). Result: same GUI probe with a fresh pinned TinyTeX v2026.10 (older than its repository, so tlmgr updates itself first): 0 new windows, `tikz-cd` installed, build ok. Along the way: an older bug made the self-update never run (`tlmgr.bat` exits 0 when tlmgr stops). It is fixed in `tinytex::outcome`, with a unit test, and the `real_tinytex_installs_missing_packages` test now passes (it failed before the change too).
- [x] 4.3 Check that Open in terminal still opens a visible terminal in the project folder, and that Open folder / Reveal still show the file manager. Result: `terminal.rs` and the opener calls are unchanged and on the guard's allow-list. The `terminal::tests` unit tests pass. The terminal was not opened by hand.
