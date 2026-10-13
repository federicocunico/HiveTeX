# Compilation: who builds the PDF and how

Nobody pays for a build server. Whichever connected device is best placed compiles for everyone and the PDF travels
peer-to-peer.

## Election

Every device advertises a **capability record** (engine kind, TeX engines it can run, benchmark, power state, load, opt-out)
and a heartbeat every 2 s; both are relayed across the mesh. Each peer computes the same winner:

```
score = engineBase (native 100 | in-browser 25) × performance × power (mains 1.0 | battery > 50 % 0.5 | else 0.2)
        × (1 − cpuLoad)        — 0 if opted out, if the project's engine is unsupported, or if the device is a viewer
```

* the sitting leader gets a 15 % hysteresis bonus (no flapping);
* a device silent for 3 heartbeats is dropped (failover in well under 10 s); a closed connection is dropped immediately;
* split meshes elect one leader per side and converge to one after they reunite.

Owners/editors can switch **"Let this device compile for the others"** off in *Project settings*.

## Compiler preference (per device)

Each device chooses how it takes part. The choice is in **Account → Compiler**, or in the **Compile** menu of a
project's status bar, applies to every project, and takes effect at once:

| Mode | Compiles here | Can lead (compile for others) | PDF shown |
|---|---|---|---|
| **Automatic** (default) | when it is the best connected device | yes, unless *Let this device compile for the others* is off (Project settings) | the leader's |
| **Use peers** | never; no LaTeX needed, the in-browser compiler is not downloaded | no | the leader's |
| **This device only** | after every edit (and *Compile on this device only*) | no | this device's own |

- With **Use peers**, someone in the project must be able to compile. When nobody can, the status bar shows *No co-author can
  compile right now*: switch to *Automatic* (with LaTeX installed, or the in-browser compiler on the web), or ask a
  co-author with LaTeX to open the project.
- **This device only** is for authors who want their own build (a different TeX distribution, or no shared builds).
  Their results are not sent to anyone, and the rest of the project keeps its leader.
- A desktop without LaTeX sets up the quick compiler at its first compile (see Engines); set `hivetex.autoCompiler` to
  `0` in its local storage to rely on peers instead.

## Pipeline

1. After edits settle (1.2 s debounce, 5 s max wait) the leader captures the project, compiles incrementally and publishes
   `{stateHash, pdfHash, synctexHash, diagnostics, log}`; the PDF and SyncTeX file travel as content-addressed blobs.
2. A request during a running compile queues exactly one follow-up run. **Recompile** is available to every role.
3. Failed builds publish the parsed errors/warnings; the last good PDF stays visible. The PDF bar shows *Outdated: N edits since the
   last compile* while edits are newer than the displayed PDF, and *Up to date* otherwise.
4. **Compile on this device only** (in the menu next to Recompile, or Ctrl+Shift+Enter) builds on the current device only (works offline) and does not distribute anything.

### Complete inputs and result identity

* **A build uses one captured set of inputs**: every text file, every image, the main document and the TeX engine, fixed together
  when the build starts. The `stateHash` of the result is computed from exactly those bytes and settings, so an edit that
  arrives while an image is still being fetched makes the result *outdated* and is built next; it never changes which state the
  finished PDF claims to show.
* **Settings are part of the identity.** Choosing another main document or engine invalidates the last PDF even though no file
  changed: the leader rebuilds, and the PDF bar shows *Outdated* until it has. The check that drives *Outdated* uses the same
  identity as the build.
* **Nothing is built without its content.** If a file the project lists has not arrived (a new leader that has the file list
  but not every text, or an image nobody online holds) the leader waits up to 8 s for it, then publishes an *incomplete*
  result that names the files (`! Compile not started: these project files are not available ...`). The previous good PDF stays
  visible, nothing is compiled with empty stand-ins, and the leader tries again every 5 s and on every edit. *Compile on this
  device only* shows the same message as an error. A project that is complete on the device compiles offline.

## Engines

Nothing has to be installed to compile. Each device uses the first compiler available, in this order:

| # | Where | Compiler | Builds shared with co-authors |
|---|---|---|---|
| 1 | Desktop | **Full LaTeX**: a TinyTeX that HiveTeX installs on request (Account → Compiler, ~70 MB download). Missing packages are installed automatically during a build (`tlmgr`), then the build is retried | yes |
| 2 | Desktop | **Your TeX distribution** (TeX Live / MiKTeX / MacTeX on `PATH`) | yes |
| 3 | Desktop | **Quick compiler**: Tectonic (~10–21 MB), set up automatically at the first compile on a computer without TeX. It downloads each package the first time a document needs it and caches it | **no**: this device only |
| 4 | Web | **Your desktop app**, if it runs on the same computer and you paired this browser with it (*Compile with my desktop app*) | as for the compiler the desktop app uses |
| 5 | Web / desktop | **In-browser compiler**: SwiftLaTeX pdfTeX/XeTeX (WebAssembly, in a worker); used only when its TeX file server answers | yes |

- Desktop builds run in a persistent per-project work directory; only changed files are written. Shell-escape is
  disabled, nothing is written outside the project, `latexmk -norc` ignores project `latexmkrc` files, and a
  wall-clock timeout (default 120 s) and memory limit apply, with the whole process tree killed on timeout.
- Reads outside the project are refused (MiKTeX) or detected through the recorder, with the result withheld (TeX Live,
  TinyTeX). Tectonic writes no recorder and reads absolute paths even with `--untrusted`. That is why the quick
  compiler builds for its own device only: it never leads a project and its PDFs are never sent to anyone. The status
  bar says *builds stay on this device*.
- The quick compiler always runs XeTeX. pdfLaTeX projects usually build unchanged; when one does not, install full
  LaTeX.
- LuaLaTeX needs a TeX distribution or full LaTeX. A device that cannot run the project's engine is never elected.
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
installed and skip otherwise; the CI workflow `.github/workflows/desktop.yml` runs them on Windows, macOS and Linux.

## Self-hosting a TeX file server for the browser engine

The browser engine fetches missing TeX files from `https://texlive2.swiftlatex.com/` by default. That public server is run
by a third party and may be unavailable; point `VITE_TEXLIVE_URL` (or the *texliveUrl* setting) at a server you control
(the SwiftLaTeX project documents the `texlive-ondemand` server). Compilation on desktop is unaffected.

## SyncTeX

The leader publishes `main.synctex.gz`. Double-click a PDF location to jump to the source line; press **Ctrl+Alt+J** in the
editor to highlight the matching position in the PDF. (Browser-engine builds have no SyncTeX data.)

## Recovery after older Windows installs

Select **Account > Compiler > Clear compiler caches** to reset build files, downloaded quick-compiler packages, temporary downloads and browser TeX files. Documents, sign-in and installed compilers are preserved. Managed full LaTeX is preferred; system tools are selected from one working installation with bounded probes. See [Windows maintenance](windows-maintenance.md).
