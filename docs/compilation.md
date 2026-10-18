# Local PDF compilation

Every device builds its own PDF. Co-authors synchronize project sources and input assets; generated PDF, log and
SyncTeX results are held in the foreground session and are not added to the shared blob store. A PDF deliberately
uploaded as a project input remains a synchronized asset.

Distributed compilation, election, capability advertisements, peer build requests and remote results have been removed.
Ambiguous case/Unicode/reserved or file-directory paths stop the build with a diagnostic before inputs reach a compiler;
rename the conflicting paths and retry. Project versions stay in History. The last successful PDF is kept in memory for
the open session only; after reopening, the project builds again.
Older `auto` and `peers` preferences migrate to `local` with a notice that stays until it is dismissed (status bar or
Account → Compiler) and links to local setup when the device has no compiler. Every Compile action, including keyboard
shortcuts (Ctrl/Cmd+Enter, Ctrl/Cmd+S, Ctrl/Cmd+Shift+Enter) and viewer builds, uses this machine. Background seeds never
load a compiler.

Blobs a 0.8.0 build leader stored as shared assets (PDF, log, SyncTeX) are not announced or served to peers: a device
offers only blobs that live files, their earlier versions and deletions, or History snapshots refer to
(`referencedBlobs`, `packages/sync/src/blobs.ts`).

## Pipeline

`LocalCompiler` captures complete sources, asset hashes, main document and engine as one immutable input. After edits
settle (1.2 s debounce, 5 s maximum wait), it builds locally. A running request coalesces additional requests into one
follow-up build. Changing compiler or settings invalidates cached results. The previous good PDF stays visible after
LaTeX errors, missing content or timeout, with its outdated status preserved.

Missing sources and assets are reported by name. Empty stand-ins are never compiled. Sources can be acquired from peers
through ordinary sync, but no build request or output travels to a co-author. Complete local projects compile without peers.

Browser worker startup has a finite deadline (30 s), as does each build. The engine's `.wasm` is downloaded first, under
its own limit, so a slow first download is not taken for a silent worker. Every folder and file sent to the worker must
be confirmed before it builds; a refused write fails the build and the next one starts a clean worker. Cancellation and
worker crashes terminate the worker and settle the request; a retry starts a clean instance. Closing a project ends its
workers, and stops a native build: the desktop app kills that build's process tree (`tex_cancel`).

A failed server HEAD probe does not disable an available local format cache. An unreachable TeX file server is checked
again after 15 s (a reachable one is remembered for 10 minutes), and Compile retries an engine that was unavailable when
the project opened. Missing uncached dependencies still need a package server. This does not imply the website shell can
start offline without having been cached independently.

## Compiler check at start (desktop)

At every start the desktop app compiles a minimal document with the compiler it would use
(`apps/desktop/src-tauri/src/compiler_health.rs`). A detected compiler is not necessarily a working one: a TeX
distribution with broken format files or package database, a managed installation left half-written, or a stale
compiler cache all pass detection and fail every build. When the check document does not compile, the app repairs, in
order, stopping as soon as it compiles:

1. clears the compiler caches (build outputs and downloaded packages; documents and installations stay);
2. a managed compiler (full LaTeX, quick compiler) is downloaded and installed again;
3. a system TeX that still fails is set aside: the app uses an installed managed compiler, or downloads the quick
   compiler. If nothing compiles either, it keeps the system TeX.

A failure that looks like missing network (a package download) is reported as *offline* and nothing is changed. The
result shows in **Account → Compiler** (*Check now* runs it again; *Use system TeX again* undoes step 3), and a start that
repaired the compiler, or could not, says so in a notice. Desktop UI test builds skip the check unless
`HIVETEX_COMPILER_CHECK=1`.
- A desktop without LaTeX sets up the quick compiler at its first compile (see Engines); set `hivetex.autoCompiler` to
  `0` in its local storage to configure a local compiler manually instead.

## Engines

Nothing has to be installed to compile. Each device uses the first compiler available, in this order:

| # | Where | Compiler | Build location |
|---|---|---|---|
| 1 | Desktop | **Full LaTeX**: a TinyTeX that HiveTeX installs on request (Account → Compiler, ~70 MB download). Missing packages are installed automatically during a build (`tlmgr`), then the build is retried | this device |
| 2 | Desktop | **Your TeX distribution** (TeX Live / MiKTeX / MacTeX on `PATH`) | this device |
| 3 | Desktop | **Quick compiler**: Tectonic (~10–21 MB), set up automatically at the first compile on a computer without TeX. It downloads each package the first time a document needs it and caches it | this device |
| 4 | Web | **Your desktop app**, if it runs on the same computer and you paired this browser with it (*Compile with my desktop app*) | same computer |
| 5 | Web / desktop | **In-browser compiler**: SwiftLaTeX pdfTeX/XeTeX (WebAssembly, in a worker); uses a reachable TeX file server or its locally cached format | this device |

- Desktop builds run in a persistent per-project work directory; only changed files are written. Shell-escape is
  disabled, nothing is written outside the project, `latexmk -norc` ignores project `latexmkrc` files, and a
  wall-clock timeout (default 120 s) and memory limit apply, with the whole process tree killed on timeout or when the
  build is cancelled.
- Reads outside the project are refused (MiKTeX) or detected through the recorder, with the result withheld (TeX Live,
  TinyTeX). Tectonic writes no recorder and reads absolute paths even with `--untrusted`, so the quick compiler cannot
  confine reads; like every compiler's, its results stay on the building device. The status bar marks it *builds stay
  on this device*.
- The quick compiler always runs XeTeX. pdfLaTeX projects usually build unchanged; when one does not, install full
  LaTeX.
- LuaLaTeX needs a TeX distribution or full LaTeX. A device that cannot run the project's engine shows a local setup error.
- When a package is missing, the build output explains what to do (install full LaTeX, check the name, ...). The raw
  log stays available.
- Every program the desktop app starts on its own (TeX detection, the build, `kpsewhich`, `tlmgr`) runs without a
  window, so opening a project or saving never flashes a console or takes focus. All of them start through
  `proc::background_command` (`apps/desktop/src-tauri/src/proc.rs`). A test fails if code starts a process any other
  way; only *Open in terminal* is meant to be visible. TeX detection runs when a project opens or the Compiler panel
  is shown. Compiles reuse its result. TinyTeX's Windows self-extractor is never run: its 7z archive is unpacked
  in-process. Spec: `openspec/specs/background-processes`.

The pinned downloads (Tectonic 0.17.0, TinyTeX v2026.10) are verified by SHA-256 before they are unpacked. A weekly
workflow (`.github/workflows/pinned-assets.yml`, `node scripts/check-pinned-assets.mjs`) checks they are still
published unchanged. To try the managed compilers on a computer that has TeX, start the desktop app with
`--ignore-system-tex`.

### Compiling from the browser with the desktop app

While the HiveTeX desktop app runs, the web app on the same computer can compile there:

1. In a project (status bar) or Account → Compiler, choose **Compile with my desktop app**. Your browser may ask
   whether the site may access apps on this device.
2. The desktop app asks *Compile for the web app?* Choose **Allow**.
3. From then on, projects opened in that browser compile with the desktop app whenever it runs. Otherwise they fall
   back to the in-browser compiler.

How it works:
- The desktop app listens on `127.0.0.1:47812` (or `47813`–`47815` when taken) and answers only the HiveTeX web
  app's origin (`https://hivetex.vercel.app`, plus your own server's origin when the desktop app uses one).
- Each pairing has a random token. The desktop keeps only its hash, and you can revoke it in Account → Compiler (the
  desktop app), or switch *Let the web app compile here* off.
- Projects are sent to the desktop app only, never anywhere else. Limits: 50 MB per request, one build at a time,
  30 builds per minute.

### Downloads and caches

- **Quick compiler packages**: `<app data>/tectonic-cache`.
- **Full LaTeX**: `<app data>/tinytex`.
- **In-browser compiler files**: on the desktop, `<app data>/texcache`, served to the engine through `texcache://`.
  On the web in Chromium browsers, a service worker cache (`hivetex-tex-v1`); files the server lacks are remembered
  for an hour. Other browsers download them again in each session.

Account → Compiler shows the space used, with *Remove* / *Clear* buttons.

### Detecting your TeX installation

The desktop app looks for `pdflatex`, `xelatex`, `lualatex` (and `latexmk`) on `PATH`:

* **Windows** – install [MiKTeX](https://miktex.org/download) and make sure its `bin` directory is on `PATH`. A fresh install
  must be allowed to fetch missing packages without prompting. The interactive installer asks about this ("Install missing
  packages on-the-fly: Yes"). For an unattended install (e.g. `choco install miktex`), run:
  `initexmf --admin --set-config-value="[MPM]AutoInstall=1"`, `miktex --admin packages update-package-database`,
  `miktex --admin packages update`, `initexmf --update-fndb`. Otherwise the engine exits before writing a log.
  MiKTeX's `latexmk` needs Perl (e.g. Strawberry Perl); without it the fallback multi-pass runner is used.
* **macOS** – install [MacTeX or BasicTeX](https://www.tug.org/mactex/); `/Library/TeX/texbin` must be on `PATH`.
* **Linux** – `sudo apt install texlive-latex-extra latexmk` (or your distribution's equivalent).

The status bar shows which compiler the device uses (*TeX Live*, *MiKTeX*, *full LaTeX*, *quick compiler*,
*desktop app (…)*, *in-browser compiler*) and what it is doing (*Setting up the quick compiler (5 / 21 MB)*,
*downloading tikz-cd.sty*, *installing pgf*). The Rust tests (`cargo test --lib` in `apps/desktop/src-tauri`) compile real documents when a distribution is
installed and skip otherwise; the CI workflow `.github/workflows/desktop.yml` requires them on Windows with TinyTeX installed.

## Self-hosting a TeX file server for the browser engine

The browser engine fetches missing TeX files from `https://texlive2.swiftlatex.com/` by default. That public server is run
by a third party and may be unavailable; point `VITE_TEXLIVE_URL` (or the *texliveUrl* setting) at a server you control
(the SwiftLaTeX project documents the `texlive-ondemand` server). Compilation on desktop is unaffected.

## SyncTeX

A local build retains `main.synctex.gz` on this device. Double-click a PDF location to jump to the source line; press **Ctrl+Alt+J** in the
editor to highlight the matching position in the PDF. (Browser-engine builds have no SyncTeX data.)

## Recovery after older Windows installs

Select **Account > Compiler > Clear compiler caches** to reset build files, downloaded quick-compiler packages, temporary downloads and browser TeX files. Documents, sign-in and installed compilers are preserved. Managed full LaTeX is preferred; system tools are selected from one working installation with bounded probes. See [Windows maintenance](windows-maintenance.md).
