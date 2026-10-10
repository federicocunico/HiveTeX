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
- A desktop without LaTeX in *Automatic* mode simply relies on peers, and says so.

## Pipeline

1. After edits settle (1.2 s debounce, 5 s max wait) the leader snapshots the project, compiles incrementally and publishes
   `{stateHash, pdfHash, synctexHash, diagnostics, log}`; the PDF and SyncTeX file travel as content-addressed blobs.
2. A request during a running compile queues exactly one follow-up run. **Recompile** is available to every role.
3. Failed builds publish the parsed errors/warnings; the last good PDF stays visible. The PDF bar shows *Outdated: N edits since the
   last compile* while edits are newer than the displayed PDF, and *Up to date* otherwise.
4. **Compile on this device only** (in the menu next to Recompile, or Ctrl+Shift+Enter) builds on the current device only (works offline) and does not distribute anything.

## Engines

| Where | Engine | Notes |
|---|---|---|
| Desktop | System **TeX Live / MiKTeX / MacTeX** (`latexmk` when available, else a built-in multi-pass fallback) (Tectonic alone is not used: its file reads cannot be verified) | persistent per-project work directory, only changed files are written, shell-escape disabled, no writes outside the project, reads outside the project refused (MiKTeX) or detected via the recorder with the result withheld (all distributions), `latexmk -norc` (project `latexmkrc` files are never used), wall-clock timeout (default 120 s), memory limit, whole process tree killed on timeout |
| Browser | **SwiftLaTeX** pdfTeX/XeTeX (WebAssembly, in a worker) | needs a reachable **TeX file server** for packages (only package *file names* are requested; sources never leave the device). Configure it under *Account → Connections*; without it the browser engine is disabled and never elected |

LuaLaTeX is desktop-only. A device that cannot run the project's engine is never elected.

### Detecting your TeX installation

The desktop app looks for `pdflatex`, `xelatex`, `lualatex` (and `latexmk`) on `PATH`:

* **Windows** – install [MiKTeX](https://miktex.org/download) and make sure its `bin` directory is on `PATH`. A fresh install
  must be allowed to fetch missing packages without prompting. The interactive installer asks about this ("Install missing
  packages on-the-fly: Yes"). For an unattended install (e.g. `choco install miktex`), run the same commands as CI:
  `initexmf --admin --set-config-value="[MPM]AutoInstall=1"`, `miktex --admin packages update-package-database`,
  `miktex --admin packages update`, `initexmf --update-fndb`. Otherwise the engine exits before writing a log.
  MiKTeX's `latexmk` needs Perl (e.g. Strawberry Perl); without it the fallback multi-pass runner is used.
* **macOS** – install [MacTeX or BasicTeX](https://www.tug.org/mactex/); `/Library/TeX/texbin` must be on `PATH`.
* **Linux** – `sudo apt install texlive-latex-extra latexmk` (or your distribution's equivalent).

The *status bar* shows "native TeX on this device" when detection succeeded; otherwise *Project settings → Build* explains
what is missing. The Rust tests (`cargo test --lib` in `apps/desktop/src-tauri`) compile real documents when a distribution is
installed and skip otherwise; the CI workflow `.github/workflows/desktop.yml` runs them on Windows, macOS and Linux.

## Self-hosting a TeX file server for the browser engine

The browser engine fetches missing TeX files from `https://texlive2.swiftlatex.com/` by default. That public server is run
by a third party and may be unavailable; point `VITE_TEXLIVE_URL` (or the *texliveUrl* setting) at a server you control
(the SwiftLaTeX project documents the `texlive-ondemand` server). Compilation on desktop is unaffected.

## SyncTeX

The leader publishes `main.synctex.gz`. Double-click a PDF location to jump to the source line; press **Ctrl+Alt+J** in the
editor to highlight the matching position in the PDF. (Browser-engine builds have no SyncTeX data.)
