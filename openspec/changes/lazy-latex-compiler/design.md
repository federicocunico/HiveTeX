# Design

## Context

- **In-browser engine.** `apps/web/public/swiftlatex/` vendors SwiftLaTeX: pdfTeX ~1.8 MB, XeTeX ~3 MB. Its worker
  fetches each missing TeX file with **synchronous XHR** from `<endpoint>pdftex/<key>`. The default endpoint,
  `texlive2.swiftlatex.com`, answers **HTTP 522 since 2026-10-09** (checked again 2026-10-10), so this engine cannot
  build anything at present.
- **Native TeX** (`tex.rs`):
  - `detect_in(PATH)` finds TeX Live or MiKTeX (pdflatex/xelatex/lualatex/latexmk);
  - compiles are hardened: no shell escape, restricted `openin`/`openout`, recorder checks;
  - MiKTeX installs missing packages itself (`--enable-installer`);
  - Tectonic is deliberately refused today (`tectonic_alone_is_never_advertised`), because no backend existed for it.
- **Engine selection** (`session.svelte.ts` `loadEngine`):
  - desktop: native only;
  - web: in-browser only.

  The capability record's `engine` (`native` / `wasm` / `none`) feeds the leader election (native outranks wasm).
- **Releases checked 2026-10-10:**
  - Tectonic `0.17.0`: `x86_64-pc-windows-msvc.zip` 21 MB, `x86_64-unknown-linux-musl.tar.gz` 10 MB,
    `aarch64`/`x86_64-apple-darwin.tar.gz` 22 MB.
  - TinyTeX `v2026.10`: `TinyTeX-1-windows-v2026.10.exe` (self-extracting) 74 MB,
    `TinyTeX-1-{darwin,linux-x86_64}-v2026.10.tar.xz` 54–67 MB.
  - Tectonic's bundle relay (`relay.fullyjustified.net`) answers 200.
- **Spike (task 1.1, done):**
  - Chromium's service worker intercepts the worker's XHR, same- and cross-origin.
  - **Firefox does not intercept XHR from workers** (only `fetch`), so the in-browser cache is Chromium-only.
- **Desktop disk cache** for the in-browser engine (`texcache.rs`, a `texcache://` protocol) is already implemented,
  with unit tests.

## Goals / Non-Goals

**Goals:**
- A desktop compiler with no visible installation.
- Packages downloaded at build time, only once.
- Web users with the desktop app compile locally.
- Every state is visible.
- Nothing installed system-wide; everything verified and removable.

**Non-Goals:**
- Hosting our own TeX file mirror (possible later if browser-only compiling matters).
- A background service that runs without the desktop app (no OS service or daemon). The helper lives as long as the
  app.
- Changing the compile policy (shell escape stays off).

## Decisions

### D1. Compiler order
- **Desktop:**
  1. system TeX (TeX Live / MiKTeX, `PATH`);
  2. managed TinyTeX (`<app_data>/tinytex`);
  3. managed Tectonic (`<app_data>/tectonic`), downloaded automatically when nothing above exists;
  4. the in-browser engine (through `texcache`).
- **Web:**
  1. the paired local helper (when reachable);
  2. the in-browser engine (when its server answers);
  3. peers only.

The capability `engine` is `native` for system TeX, TinyTeX, Tectonic and the helper; `wasm` for the in-browser engine.
`supports` lists the engines each one can run (Tectonic: `xelatex`, plus `pdflatex` as a compatible mode, D3).

### D2. Managed downloads (shared by Tectonic and TinyTeX), `src/managed.rs`
- **Pinned table** of `(component, version, platform) → {url, sha256, size}` in source, with the hashes filled from the
  release assets at implementation time.
- **Download:** `reqwest` stream into `<app_data>/downloads/<file>.part`, emitting `managed://progress {component,
  received, total}`; the SHA-256 is computed while streaming; on mismatch the file is deleted and an error returned.
- **Extract** into `<app_data>/<component>.tmp/`, then rename to `<app_data>/<component>/` (atomic swap):
  - zip: the `zip` crate;
  - `.tar.gz` / `.tar.xz`: `tar` + `flate2` / `xz2`;
  - Windows TinyTeX `.exe`: a 7-Zip self-extractor, run as `<exe> -y -o<dir>`.

  Every entry path is validated (no absolute paths, no `..`; zip-slip).
- **Remove:** delete the folder.
- **Status:** `managed_status` reports installed versions and sizes.

### D3. Tectonic backend (`tex.rs`, flavor `tectonic (managed)`)
- **Command:**

  ```
  tectonic -X compile <main> --untrusted --synctex --keep-logs --outdir <out>
  ```

  run in the existing isolated working copy, with `TECTONIC_CACHE_DIR=<app_data>/tectonic-cache`.
  - `--untrusted` disables shell escape and other insecure features.
  - The existing timeout and process-tree kill apply.
- **Results:** reuse the result pipeline (PDF, SyncTeX `.synctex.gz`, log).
- **Engine mapping:** Tectonic always runs XeTeX. Projects set to pdfLaTeX are compiled by it too, and the log gets a
  one-line note; if the build fails on pdfTeX-only primitives, the result suggests full LaTeX.
- **Detection:** once installed, `detect()` reports the flavor `tectonic (managed)`, which removes the old
  "never advertised" rule; the test changes to "advertised only when managed and verified".
- **Packages:** progress comes from Tectonic's stderr (`note: downloading <file>`), re-emitted as
  `compile://package {name}` for the status bar.
- **Automatic set-up:** the first compile on a desktop with no native TeX runs `managed_install("tectonic")` with
  progress, then compiles. Account → Compiler has *Download compiler now* for offline preparation. Opt-out:
  `hivetex.autoCompiler = '0'` shows a button instead of downloading by itself.

### D3b. Tectonic builds are local-only (security)
Verified on 2026-10-10 with Tectonic 0.17.0:
- `-X compile --untrusted` opens and typesets `input{C:/…/secret.txt}`;
- no recorder file is written.

What a document read cannot be verified, so a Tectonic device would let a co-author exfiltrate local files through
shared PDFs. Therefore:
- **Native side:** the flavor `tectonic (managed)` is reported with `verified_reads: false`.
- **Capability record:** `engine: 'native'` plus `optOut: true`, so the device is never the leader.
- **Session:** behaves as compile mode `local` for that device. It compiles its own copy after edits, and its results
  are never sent.
- **Helper:** `/status` reports `verifiedReads`; the web side advertises the helper to the election only when it is
  true.
- **Trusted TeX roots:** the managed TinyTeX root joins `tex_roots()`, so `verify_reads` accepts reads from it and
  TinyTeX devices can lead.

### D4. Managed TinyTeX and on-demand packages (`src/tinytex.rs`)
- Install and remove through D2.
- **Detection:** `<app_data>/tinytex/bin/<platform>` before Tectonic; flavor `tinytex (managed)`.
- **On a failed compile** whose log matches ``! LaTeX Error: File `(.+)' not found.``:
  1. `tlmgr search --global --file /<name>`, then pick the package name (validated `^[a-z0-9-]+$`);
  2. `tlmgr install <pkg>` (`compile://package {name, state}`);
  3. recompile, at most 3 rounds, with a per-name result cache to stop loops.

  Only for the managed flavor.

### D5. Local compile helper (`src/helper.rs`)
- **Listener:** HTTP on `127.0.0.1:47812` (fixed, documented; if taken, try `47813`…`47815`), started with the app,
  off when the user disables it (Account → Compiler → *Let the web app compile here*, default on).
- **Origins:** requests must carry an `Origin` in the allowlist: the desktop's configured server origin, default
  `https://hivetex.vercel.app`. CORS replies only to that origin, and preflights answer
  `Access-Control-Allow-Private-Network: true` (Chromium Private Network Access).
- **Pairing:**
  1. `POST /pair {username, server}` opens a confirmation in the desktop app: "Allow the HiveTeX web app (`<username>`
     on `<server>`) to compile on this computer?"
  2. On *Allow*, it returns a random 256-bit token, stored in the desktop's keychain list of pairings. The web app keeps
     it in localStorage. *Deny* returns 403.
  3. Account (desktop) lists pairings and can revoke them.
- **Endpoints:**
  - `GET /status`: no secret; returns name and version only, to detect the helper;
  - `POST /compile` (Authorization: `Bearer <token>`): body is JSON `{main, engine, files: [{path, b64}]}`, capped at
    50 MB. It runs the same compile as the desktop app's own (D1 native order, hardening, timeout) in a fresh temp dir,
    and returns `{ok, log, pdf_b64, synctex_b64}`.
  - Paths are validated like the mirror's (`resolve_inside`).
- **Limits:** one compile at a time (a newer request cancels the older), 30 compiles per minute per token.
- **Web side:** `lib/helper-engine.ts`, a `CompileEngine` (`kind: 'native'`) wrapping the endpoint.
  - `loadEngine()` on the web probes `GET /status` (300 ms timeout).
  - When reachable with a token, it is used. When reachable without one, the Compiler panel and the first compile
    offer *Compile with my desktop app* (pairing).

### D6. In-browser fallback and caches
- The engine is selected only when nothing above is available **and** a HEAD probe of its format file succeeds
  (existing `texServerReachable`).
- **Cache:**
  - Chromium web: the service worker `public/sw.js` (cache-first `hivetex-tex-v1`, 1-hour negative entries, progress
    `postMessage`).
  - Desktop: `texcache://` (done).
  - Firefox: uncached, as the panel states.

### D7. State and UI
- **Session:** `compilerState` = `{source: 'system' | 'tinytex' | 'tectonic' | 'helper' | 'wasm' | 'peers' | 'none',
  phase: 'ready' | 'setting-up' | 'packages' | 'unavailable', detail?}`, fed by the `managed://progress` /
  `compile://package` events (desktop), service-worker messages (web) and helper responses.
- **Status bar:** shows the compiler name and phase ("Setting up the compiler 12/30 MB", "Downloading siunitx").
- **Compile failures:** a banner maps "could not obtain package X" to a short message plus suggestions; the raw log is
  still available.
- **Account → Compiler** (with the mode choice from `hosted-default-server`):
  - current compiler, space used, *Download compiler now* / *Clear*, *Install full LaTeX* / *Remove* (desktop);
  - *Let the web app compile here* with the pairings list (desktop);
  - *Compile with my desktop app* / *Unpair* (web).

## Risks / Trade-offs

- **Tectonic is XeTeX-only.** pdfTeX-specific documents may fail; they get a clear hint, and full LaTeX is one click
  away.
- **The bundle server is third-party** (Tectonic project). If it goes down, cached packages keep working; new packages
  fail with a message, and full LaTeX remains an option.
- **The local helper is a network service on loopback.** Mitigated by:
  - origin allowlist;
  - pairing confirmed in the app;
  - per-pairing tokens, revocable;
  - size and rate limits;
  - the same compile hardening as local builds;
  - no file access outside the request's temp dir.

  DNS rebinding cannot read responses, because of the Origin and token checks.
- **Pinned releases need bumping:** a scheduled CI job checks that the URLs resolve and the checksums still match.
- **TinyTeX's package repository is unsigned** (`tlnet.yihui.org`; tlmgr says "not verified: pubkey missing"), so package integrity relies on HTTPS. Verified behaviour on Windows (2026-10-10):
  - a fresh TinyTeX v2026.10 needs `tlmgr update --self` before installing; the update finishes in a background
    process, so installs retry briefly;
  - after installing, latexmk must be forced (`-g`), because no source changed;
  - a document using tikz-cd triggers two rounds (tikz-cd, then pgf) and then builds.
- **Disk use:** Tectonic ~30 MB plus packages; TinyTeX ~250 MB unpacked. Both are visible and removable.
