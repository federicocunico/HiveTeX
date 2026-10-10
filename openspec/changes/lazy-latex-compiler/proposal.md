# Proposal

## Why

HiveTeX should work as a LaTeX IDE without asking anyone to install LaTeX first. Today:

- **Desktop:** without a native TeX installation the app has no compiler at all, and there is no guided way to get one.
- **Web (hivetex.vercel.app):** compiling relies on the in-browser engine (SwiftLaTeX). It fetches every TeX file from
  a public server that has been down since 2026-10-09 (HTTP 522), so web users without a co-author's desktop
  compiling for them cannot build PDFs at all. Nothing is kept between sessions, and errors are raw engine logs.

Implementation of the first plan (in-browser engine + cache) showed that the public server is not a dependable base.
The owner chose a sturdier direction instead:

- a light native compiler that downloads only the packages a document needs, at build time;
- the desktop app doubling as a local compile service for the web app.

## What Changes

- **Quick compiler on desktop, automatic.** On the first compile without TeX installed, the app downloads Tectonic, a
  single ~30 MB LaTeX engine. The version is pinned and the download checksum-verified; it goes into the app's folder,
  with progress shown and no admin rights. Tectonic downloads the packages a document needs at build time from its
  package bundle, and keeps them on disk, so later and offline builds reuse them. Compiles run with Tectonic's
  untrusted mode (no shell escape).
- **Full LaTeX on desktop, optional and guided.** *Install full LaTeX* installs TinyTeX (~100 MB, pinned, verified)
  into the app's folder for documents Tectonic cannot build (pdfTeX- or LuaTeX-specific). Missing packages are
  installed on demand with `tlmgr`, never into a system TeX installation. It can be removed.
- **Engine order on desktop:** system TeX (TeX Live, MiKTeX), managed TinyTeX, managed Tectonic, then the in-browser
  engine.
- **Local compile helper for the web app.**
  - While the desktop app runs, it offers a compile service on `127.0.0.1`.
  - The web app finds it, asks the user to pair once (confirmed in the desktop app), then compiles on the user's
    machine with the desktop's compiler.
  - The helper accepts only the HiveTeX web origin and paired requests.
  - A web user with the desktop app counts as a native compiler, and can compile for co-authors.
- **In-browser engine as fallback.** It is used only when no native compiler or helper is available and its package
  server answers. Downloaded TeX files are kept (a service worker on Chromium; a disk cache on desktop), so it keeps
  working offline for documents built before.
- **Seamless setup feedback.**
  - Status bar: "Setting up the compiler (downloading 30 MB)…", "Downloading package `siunitx`…", "Installing package
    tikz-cd…".
  - Account → Compiler shows which compiler is used, the space taken, *Prepare*, *Clear*, and *Install full LaTeX* /
    *Remove*.
  - When nothing can compile here, the message says so and points to peers, the desktop app or full LaTeX.

## Capabilities

### New Capabilities

- `compiler-provisioning`: how every device gets a working compiler without prior installation, and what it shows
  while doing so:
  - the automatic quick compiler (Tectonic) with lazy packages;
  - the optional managed full LaTeX with on-demand packages;
  - the local compile helper for the web app;
  - the in-browser fallback and its cache.

### Modified Capabilities

(none). `distributed-compilation` already covers advertising whichever engine a device has.

## Impact

- **`apps/desktop/src-tauri`:**
  - `tectonic.rs`: download/verify/extract, compile with untrusted mode, cache dir;
  - `tinytex.rs`: install/remove, `tlmgr`;
  - `helper.rs`: localhost compile service, pairing, origin checks;
  - `texcache.rs`: disk cache for the in-browser engine (done);
  - detection order in `tex.rs`;
  - CSP, capabilities.
- **`apps/web`:**
  - engine selection: desktop order; web uses helper, then wasm (if reachable), then peers only;
  - a helper client engine and pairing UI;
  - the service worker (Chromium);
  - compiler state and progress;
  - Account → Compiler.
- **Network:**
  - GitHub releases: Tectonic and TinyTeX archives, only on first use or when chosen.
  - Tectonic's bundle server: packages, lazily.
  - CTAN mirrors: TinyTeX `tlmgr`.
  - SwiftLaTeX's server: in-browser fallback only.
- **Docs:** `docs/compilation.md`, README first-run notes.
