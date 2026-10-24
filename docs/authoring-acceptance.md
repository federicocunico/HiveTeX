# Authoring workspace acceptance

Change: `stabilize-authoring-workspace`. Baseline source: `2a8d2ed`. Local environment: Windows, Node 22.22, Playwright Chromium, 2026-10-21.

## Editor geometry (A01)

`pnpm exec playwright test e2e/editor-geometry.spec.ts --retries=0`: **3 passed** (19.8 s).

The original 6200-line fixture covers LF/CRLF, blank and long wrapped lines, equations and Unicode. The browser probe resolves each numeric gutter label to its logical CodeMirror line, excludes hidden spacers and polls settled layout. All 48 font/width/scroll combinations (11/14/18/24 px, 1440/1180 px widths, lines 1/1900/6100) met the 1.5 CSS px tolerance with no outer document overflow. Both themes were exercised. A deliberate 7 px gutter transform was detected, then removed and verified again.

Two authenticated browser contexts also verified remote line insertion/deletion above a selection, clipboard source without gutter text, local undo/redo with exact full-document restoration, and switching to another file and back. Native webview acceptance remains separate. The editor accessor is available only in development or explicitly isolated E2E builds.

The real article visual review subsequently reproduced overlapping numbers on CRLF blank lines. A CR-only CodeMirror line has text content but collapses to zero height in browser layout. The original probe compared source/gutter tops, so it missed rows where both collapsed. The theme now gives every logical source line a minimum height equal to the configured line height (1.65 em). The fixture has blank lines near the beginning; the probe also rejects collapsed rows. A negative control removes the minimum height and must reproduce the collapse. All three strengthened geometry tests passed again on 2026-10-22, covering the same 48 combinations without a positional offset.

The maximum font/narrow-pane capture also demonstrates why wrapping can make logical line numbers appear far apart: each logical line spans several visual rows. That is expected numbering, not missing line numbers. The visual refinement must keep the gutter compact without numbering wrapped fragments as new source lines.

Run artifacts are emitted under Playwright's `test-results` directory (screenshots and attached geometry JSON). They are diagnostics, not product screenshots; this suite intentionally uses the fake compiler to isolate editor behavior.

## Scheduling (A02)

`pnpm --filter @hivetex/compile exec vitest run test/scheduling.test.ts test/local.test.ts`: **19 passed**. Deterministic clocks cover 1500 ms debounce, 5000 ms maximum wait, periodic dirty checks, one running plus one shared pending promise, explicit requests, failure suppression, dependency/engine recovery and disposal. The existing local suite also checks immutable acquisition, co-author builds and cancellation.

`pnpm --filter @hivetex/web exec vitest run test/preferences.test.ts`: **6 passed**. Browser `compile-scheduling.spec.ts` passes (18.5 s), including device independence, persistence/reload, actual storage events from a second tab, invalid interval retention, keyboard selection preservation, palette and compile-menu settings. `compile-modes.spec.ts` also passes, retaining legacy migration and local execution. These scheduler tests intentionally use the fake engine; they do not establish TeX compatibility.

`svelte-check --tsconfig ./tsconfig.json`: **0 errors**, 12 existing warnings across 7 files.

## Real compiler reproduction (A03)

The new article/report fixture reads the shipped sources, includes `refs.bib`, all report chapters and a binary PNG, and extracts text from the produced PDF to check bibliography and references.

The initial package fixture had two defects: missing `fileid`/`pkid` CORS response headers caused resources to alias `/tex/null`, and extensionless TFM requests were not resolved. After correcting those, both templates failed at `amsmath`'s `\\DeclareCommandCopy`: SwiftLaTeX pdfTeX 1.40.21 / format LaTeX 2020-02-02 patch 2 / L3 2020-02-14 cannot load current installed packages (article/report 2025-01-22, amsmath 2025-07-09). The public default server returned HTTP 522 during this run. This is separate from package compatibility.

`e2e/texlive-2019.ts` pins complete historical archives by SHA-256 for the initial compatibility reproduction. That fixture established the compatible resource generation; the production distribution and cache implementation are recorded below. The WASM adapter completes bibliography/reference passes within one build deadline.

The initial compatible-fixture run passed **2 tests** (29.8 s), each compiling cold, warm and after a browser reload with the package server stopped. PDF text contained the actual titles, Knuth/Lamport bibliography entries and resolved numeric references; the image was a valid PNG. A first fixture PNG had an invalid CRC and was replaced before acceptance. This was a fixture defect, not a native engine defect. The final production-resource acceptance below supersedes this fixture-only evidence.

`HIVETEX_NATIVE_TESTS=1 pnpm --filter @hivetex/compile exec vitest run test/native.test.ts`: **5 passed** (2026-10-22, 109.6 s including bridge build). The current Rust bridge builds both templates cold and warm; the real paired HTTP helper also builds both cold and warm. Native environment: MiKTeX 25.4 / pdfTeX 1.40.27, format 2025-11-11 (LaTeX 2025-11-01, L3 2025-10-24). PDF text, bibliography/reference resolution and native SyncTeX are asserted. No native production adapter change was required for these template cases. Network-isolated native acceptance and package failure/retry remain tracked, not claimed by warm-cache tests.

## Production WASM distribution (A03)

The default app now includes **21 compatible TL2019-final packages / 4311 resources**, both pinned February 2020
formats, and the matching SwiftLaTeX v20022022 engines. Archive, format and engine SHA-256 pins are recorded in
[`tex-distribution.lock.json`](../scripts/tex-distribution.lock.json). Original package metadata, documentation,
license notices and available source archives accompany the generated static distribution. Only needed runtime
resources are downloaded by a browser; desktop packaging includes the set directly.

Current distribution identity: `tl2019-5eed4a4ac9c250ecc67f2f74`.
Manifest SHA-256: `d6a5fdd75c4f7d0f64ac0132283c985c95ffed91ce2fdf91735336ee37eb7c78`.
The identity incorporates the lock, generator and lookup adapter; Turborepo now also hashes those root inputs.
Browser caches use `hivetex-tex-v2:<distribution URL>` and verify content-addressed downloads. Custom desktop
endpoints use `v2-<SHA256(endpoint)>` disk namespaces. Upgrades retain previous caches and cannot populate a new
distribution with old resources; explicit cache maintenance preserves project stores. A saved legacy public default
migrates to the included distribution, while explicit custom servers remain available.

The expanded real matrix found an additional defect: the vendored XeTeX worker emits **XDV**, previously exposed as
if it were PDF. The app now completes conversion with the matching Dvipdfmx worker, including original image/font
assets and resolved font IDs. TeX passes and conversion share one execution deadline and cancellation. Tests reject
converter startup hangs without accepting XDV as a PDF.

On 2026-10-24, `pnpm exec playwright test e2e/compiler-templates.spec.ts --retries=0` passed all **4 combinations**
(article/report × pdfLaTeX/XeLaTeX) in 24.7 s, each cold, warm and after reload with compiler resources blocked,
with resolved PDF text/bibliography/references and the PNG fixture.
These tests use the actual bundled default, with no TeX fixture server or fake engine.

The current production Vite build passes. The production UI journey passes **2/2** (20.6 s in this checkout): create templates, select XeLaTeX for the
report, compile and download PDFs, edit to invalidate accepted output, and compile again warm/offline. It serves
the actual Vite production bundle, uses no development-module/session injection, and validates downloaded PDF text.
The application shell/API remain available; only compiler-resource network access is blocked on reopen.
[Checksums and six PDF results](evidence/authoring/wasm-production.json),
[offline article PDF](evidence/authoring/bundled-article.pdf), [offline report PDF](evidence/authoring/bundled-report.pdf).

The earlier isolated checkout, using distribution `tl2019-9192d084f8ad27a369bc2b0e`, verified **46 archives / 128,336,928 bytes**. That check reproduced
Windows Git CRLF conversion breaking the upstream JavaScript checksum. Preparation now restores upstream LF before
checking JS, keeps WASM byte-for-byte validation, and verifies vendored engines even when generated output exists.
The corrected build passed (27.52 s), and its complete manifest was byte-identical to the main workspace's manifest
at that time. Clean-checkout equality has not been remeasured for the current distribution.
The production harness also uses the normal 120 s startup allowance for a cold preview server.

The prior focused browser regression: **6/6 passed**, including the four bundled combinations, the existing real custom
server journey and package-cache behavior. WASM/cache/CI-policy units: **21/21**; local scheduler/failure units:
**27/27**; worker/availability/snapshot/history units: **35/35**; Rust endpoint-cache tests: **4/4**. Frontend checking
reports zero errors and the 12 existing warnings; initial JavaScript is **190.9 KiB gzip / 250 KiB budget**.
The 2026-10-24 selective reviews resolved five P2 defects: concurrent TeX distribution staging/download ownership,
XeTeX converter startup allowance across retries, stop/prepare/startup cancellation ownership, PDF resize
virtualization and reading-anchor retention across overlapping loads. Their focused compiler, renderer, browser,
Rust and CI-policy regressions are recorded in the [compiler](evidence/authoring/review-compiler.md),
[workspace](evidence/authoring/review-workspace.md) and [desktop/CI](evidence/authoring/review-desktop-ci.md)
review reports. The current real compiler and production checks above provide final integration evidence after those fixes.
Raw compiler logs and cache identities accompany [`wasm-production.json`](evidence/authoring/wasm-production.json).
No push, hosted CI run or release publication was performed. The earlier macOS/Linux WebView acceptance gaps remain
explicitly recorded rather than counted as passes.

## Recoverable failures (A07)

### Native package recovery, 2026-10-23

A disposable TinyTeX 2026.10 distribution exposed an unbounded `tlmgr` subprocess and a truncated `ls-R` filename
index after an interrupted installation. Native compilation now shares one deadline across package acquisition,
TeX/bibliography passes and subprocess descendants. A pending-install marker causes the next build to regenerate
the index. Managed desktop/helper builds are serialized while using the shared installation.

`native-managed.test.ts` passed (290.6 s): intentionally damaged index repair; HTTP 503 package acquisition failure;
explicit successful retry for `tikz-cd` (native) and `lipsum` (paired HTTP helper); then article/report and the newly
installed packages with the repository unavailable and **zero repository requests**. This uses the real compiler,
real package manager and PDF text assertions. The interrupted-index fixture reproduces the observed partial-index
failure without corrupting a user's installation. The normal native/helper suite subsequently passed **5/5** again
(90.0 s including bridge rebuild) on the current serialized implementation.

Distribution: `rstudio/tinytex-releases` v2026.10, `TinyTeX-1-windows-v2026.10.exe`, SHA-256
`36c329c644683d981a668419d13c8804696e2816ae4d287ad755788fee231a31`.
Engine: pdfTeX 1.40.29 / TeX Live 2026 / format 2026.10.1 / LaTeX 2026-06-01 / L3 2026-09-09.
The temporary managed root is independent of installed MiKTeX and the production app profile.

The native WebView journey also reproduced a newly created complete worker document being reported as missing by
the renderer's `missingText()`. Consequently a successful PDF was immediately called outdated with zero edits.
`missingText()` now consults the authoritative availability method, as snapshot capture already does. The worker
regression failed before the fix; all **14 worker runtime tests** and **19 local compiler/scheduler tests** passed after it.

Rust compiler/package tests on the final serialized implementation: **27 passed, 2 pre-existing opt-in tests ignored**
(44.3 s). The process deadline regression verifies that installer descendants are terminated and cannot write after
the deadline; the second request with the expired deadline cannot launch a process.

Structured causes now distinguish missing compiler, unsupported engine, unavailable project input, package acquisition, source error, timeout and runtime failure. Problems shows the summary and recovery actions even when collapsed. Setup notes cannot show “No problems”. The existing last-good-PDF behavior is retained.

Failure/scheduler/local unit suites: **27 passed**; preferences, Problems panel and compiler-status suites: **14 passed**; WASM runner suite: **9 passed** (including bounded passes and one deadline). `compiler-state.spec.ts`: **2 passed**, with a missing package retaining exactly the previous canvas, an outdated marker, correction clearing the error and replacing the PDF, and absent compiler presenting setup without a success badge. Compiler UI tests use the fake engine for deterministic failure injection; the separate real template tests establish actual compilation.

## PDF consistency and responsiveness (A04, A05)

`pnpm --filter @hivetex/web exec vitest run test/pdf-renderer.test.ts test/pdf-revision.test.ts`: **8 passed**. Controlled promises verify old load success/failure, render cancellation on zoom, close during parsing, and delayed SyncTeX parsing. A build carries the source sequence/time and engine captured before asset acquisition; edits arriving during compilation count against that revision. A new successful PDF immediately clears the old mapping; a later failure preserves the last successful PDF and its mapping. Old highlights cannot carry over to a new PDF.

The renderer keeps placeholders for all pages, prioritizes visible pages, retains at most six canvases and runs at most two render tasks. Distant-scroll and ten open/close tests verify bounded canvases and task destruction. `pdf-preview.spec.ts` passes with a 100-page fixture, page 50 navigation, landscape page 51, distant scrolling, page-relative position across zoom/new output and retained source focus. `synctex.spec.ts` passes (13.9 s) with reverse search at 120/130/140%, included-file navigation, forward highlight coordinates, and both directions disabled when no map is available. The fixture is A4; the probe reads its actual page width rather than assuming US Letter.

`compiler-state.spec.ts` and `compile-scheduling.spec.ts`: **3 passed** (32.4 s) with the new renderer, including preservation of the actual last-good canvas after compilation failure. The 100-page PDF is a synthetic renderer stress fixture, not a product screenshot or evidence of real TeX compilation.

## Formatting overflow (A06)

`format-overflow.spec.ts`: **1 passed** (8.9 s). The toolbar measures its heading and overflow label, keeps a stable visible prefix and moves the remaining actions into a keyboard menu. The test verifies all actions exactly once, menu ordering, Home/End/Escape, insertion on the existing selection, return of actions after widening, and preserved keyboard focus. `authoring.spec.ts`: **4 passed** with collaboration and existing table/citation/symbol pickers.

The new immediate-undo check reproduced a real defect: a formatting action could merge into the preceding typing transaction within Yjs's capture interval. `insertWith` and source fixes now delimit their own undo groups. Undo restores exactly the selected source even when the menu is used immediately after typing.

## Workspace status (A08)

The compact status bar has separate save, source sync and local PDF/build summaries. Compiler identity, package/setup details and desktop pairing are in the keyboard-accessible Workspace status dialog; warnings and recovery export stay directly reachable. `workspace-status.spec.ts`: **1 passed** (11.5 s), using an editor peer and an explicit sync round to verify fully reconciled sources alongside an outdated Manual PDF, then a build error and independent storage-failure injection at 1280/1024/800 px. A viewer receipt intentionally cannot certify another author's document; that existing access rule remains intact.

Existing workspace, scheduling, migration, failure and desktop-pairing journeys: **16 passed**. Compiler-status unit tests: **3 passed**. The new status dialog preserves migration dismissal and live helper adoption, and Escape returns focus to its opener.

## Compiler CI baseline clarification (A10)

The audit initially noted that the real WASM smoke was absent from `.github/workflows/ci.yml`. It is already **required in `.github/workflows/desktop.yml`** after TinyTeX setup. The implementation strengthens that existing lane with actual article/report fixtures; real WASM testing was not wholly absent.

## Visual and accessibility review (A06, A08, A11)

[Reviewed contact sheet](images/authoring-review.png): real article, both themes, 1440x900 / 1280x800 / 1024x768,
long names and loading, ready, stale, source-error, offline and collaborating states. The narrow layout includes both
Editor and PDF. Shared pane/toolbar heights, a narrower nonselectable gutter, quieter PDF surfaces and compact
status controls retain the honey accent and existing four-action header/focus contracts.

`authoring-visual.spec.ts` passed the complete matrix and then replayed all eight baselines without updating them
(2026-10-22, 2.5 minutes). Reference environment: Windows, Node 22.22.0, Chromium 156.0.8078.4; bundled fonts 5.3.0.
The test verifies real PDF text/bibliography and error recovery, 125%/150% CSS zoom, both themes, overflow keyboard
navigation and dialog focus return. Axe reports no serious/critical findings on the workspace and affected menus/
dialogs after the PDF has rendered. CodeMirror retains the existing axe exclusion. A discovered invalid label on a
generic page wrapper was corrected by giving the PDF page an explicit group role.

Review corrected two fixture blind spots: narrow PDF screenshots must wait for the remounted renderer, and simulated
storage failures must enter through the model's durability error state rather than a reactive field overwritten by
runtime updates. The latter status test passed again; existing workspace/header/focus cases also passed. Baseline
updates pin the article date and stabilize only the random-name mask width; unmasked contact sheets retain the actual
long names. Product screenshot generation now always requires real LaTeX, with no injected-PDF fallback.

CI policy tests: **4 passed**, including mutations that suppress required failures or omit coverage. A deliberately
failing temporary Playwright test exited **1** with zero retries, and the fixture was removed. PDF renderer/revision
and policy unit suites together: **12 passed**. No push or remote workflow run is claimed by these local checks.

## Native authoring (A01, A02, A04, A09)

On 2026-10-23, `native-authoring.spec.ts` passed in the actual Windows WebView2 **155.0.4283.62** using the
isolated **0.9.1** executable / `app.hivetex.desktop.e2e` identity. Manual article compilation and an automatic
follow-up both produced real PDF text, including the inserted marker. Initial acceptance used MiKTeX 25.4 / pdfTeX
1.40.27 / format 2025.11.11. The final run installed managed TinyTeX v2026.10 through the real app IPC, launched a
secondary during setup and verified its handover, then repeated authoring with pdfTeX 1.40.29 / format 2026.10.1.
That run passed in **36.8 s**. PDF zoom succeeded. All **24 CRLF font/width/scroll combinations** met the 1.5 px
contract, with maximum measured discrepancy **0.073 px** and no collapsed rows or outer application scroll.

[Raw native measurements and process records](evidence/authoring/native-windows.json),
[compiler log](evidence/authoring/native-compiler.log), [reviewed screenshot](images/authoring-native.png).
The final screenshot intentionally shows Manual/outdated after adding the separate long manuscript; the completed
automatic-build assertion precedes those edits. Lifecycle records before/during/after builds retain one registered
tray icon, one main window and one direct sync worker. Compiler/WebView descendants are distinct from app owners.
**Missing webview acceptance:** macOS WKWebView and Linux WebKitGTK. Production-identity startup is verified separately below.

## Integrated stress and regression gates (A01–A10)

`authoring-stress.spec.ts` compiled the complete 6200-line manuscript with the real pinned WASM fixture into **519
pages**, checking text at the end of the source. Two collaborators converged exactly after separate offline edits.
Theme/width changes, PDF zoom, distant scroll, bounded canvases (at most six), exact undo and a real TeX error followed
by correction passed. Failed compilation retained identical accepted PDF bytes. Both source and PDF stayed visible.

The final run passed in **42.5 s**; measured p95 input/scroll-to-frame latency was **43.3 ms** (55 samples after
warm-up), below the 100 ms target and 250 ms gate. [Raw samples and runner](evidence/authoring/interaction-windows.json),
[reviewed final screenshot](images/authoring-stress.png). The first fixture attempt incorrectly expected undo to
separate an immediate edit from the preceding synthetic Yjs capture group; a pause now explicitly separates those
user interactions. No production undo semantics were changed for that fixture correction.

The combined stress/native/history/three-client browser run passed **4/4** (1.4 min). Existing availability, snapshot,
live history and checkpoint unit tests passed **21/21**. CI policy tests passed **5/5**, now also requiring the dedicated
stress lane and retained raw measurements. These are local results; hosted CI has not been triggered by a push.

## Clean checkout and first setup (A03, A10)

Created a separate detached checkout at baseline `2a8d2ed`, overlaid the implementation files with byte comparisons,
and installed its own dependencies using `pnpm install --frozen-lockfile` (pnpm 10.34.6, Node 22.22.0). No source stores,
browser profiles or built frontend were copied. Build and required native bridge preparation succeeded there. Cargo
dependency artifacts were reused, but the bridge was rebuilt from that checkout by the required native test helper.

Native/helper template tests passed **5/5** with the existing disposable distribution (88.9 s), then **5/5** with a
new extraction of the checksum-verified TinyTeX v2026.10 archive (45.5 s). Both article and report compiled cold and
warm, including real text, bibliography/reference output and SyncTeX. Browser template acceptance used a new temporary
directory, forcing fresh historical package acquisition/checksum verification, and a new browser context per template:
**2/2 passed**, 33.8 s total, covering cold, warm and reload with package server stopped. This initial run certified
the pinned fixture. The subsequent production-distribution checkout acceptance is recorded below.

Required CI now includes native/helper templates, managed package recovery, actual Windows WebView2 authoring/setup,
real WASM templates, visual baselines and the dedicated stress budget. Missing native prerequisites fail the opted-in
lanes. Artifact upload retains native lifecycle records as well as browser logs/traces/screenshots.

## Isolated lifecycle (A09)

The current 0.9.1 E2E build passed **9 recorded scenarios**: 12 simultaneous launches across two paths during delayed
startup and again without the artificial delay; close to tray; secondary reopen; browser pairing reopen; update restart; background login; manual startup
with background preference; and maintenance cleanup. Every active owner retained one native tray and one bundled
Node worker. Closed/background states had zero visible main windows. Startup can retain a hidden configured webview,
whereas close-to-tray destroys it; the test records both total and visible windows separately.

[Raw lifecycle records](evidence/authoring/lifecycle-windows.json). The runner ended with no test app left over.
The real setup/build journey above additionally records unchanged ownership during TinyTeX installation and manual/
automatic compilation. Rust hidden-process guards passed **3/3**, including the audit of all production launch sites.

## Finding-to-test closure

| Finding | Implementation and evidence | State / remaining limit |
| --- | --- | --- |
| A01 — line numbers | Minimum logical-line height fixes collapsed CRLF blank rows; geometry probe rejects collapse and detects deliberately shifted gutters. Browser LF/CRLF/peer matrix, real Windows WebView matrix and integrated stress pass. | Fixed; macOS/Linux webview acceptance missing. |
| A02 — manual compilation burden | One bounded scheduler, device-local After changes/Periodic/Manual settings, failed-input suppression and explicit retry. Clock tests, preferences/browser journeys and real native automatic PDF pass. | Fixed. |
| A03 — actual TeX output | Versioned bundled TeX distribution; real article/report with pdfLaTeX and XeLaTeX/Dvipdfmx, bibliography/image/references, cold/warm/offline resources. Production UI downloads real PDFs. Native/helper package timeout/index repair fixes reproduced failures. | Fixed for the supported article/report combinations; extra packages require a compatible custom distribution or full desktop TeX. |
| A04 — preview races/long PDFs | Generation-owned loading/rendering, visible-first pages, two render jobs and six canvases. Controlled races, 100-page renderer test and real 519-page stress pass. | Fixed. |
| A05 — source/PDF mismatch | Captured source/engine identity, matching SyncTeX lifecycle and preserved last good PDF. Mapping races, edit-during-build and SyncTeX navigation pass. | Fixed. |
| A06 — unreachable controls | Measured formatting overflow, keyboard focus/selection restoration and narrow status details. Overflow, zoom/resize and axe checks pass. | Fixed. |
| A07 — misleading failures | Structured setup/input/package/source/timeout causes, visible recovery and last-good output. Real package outage/source-error recovery, corrupt-resource retry and XeTeX converter deadline pass. | Fixed for verified supported engines. |
| A08 — mixed save/sync/build meaning | Separate durable-save, source-sync and local-PDF status; compiler identity/details and schedule. Browser status matrix and OpenSpec delta remove peer-build-leader wording. | Fixed UI and change specification; main-spec synchronization follows the normal review/archive workflow. |
| A09 — desktop lifecycle | Early reopen during initial WebView construction and rapid close during reconstruction reproduced in the actual package. Startup readiness and hidden-until-constructed reopening fix both. Native and packaged process/tray/window checks pass. | Fixed reproduced startup/reopen failures; the original report of multiple owning processes/trays was not reproduced. |
| A10 — acceptance gaps | Required focused authoring, pinned real-template/visual, native/helper/WebView and dedicated stress lanes; zero retries, negative gate checks and retained diagnostics. Clean-checkout local runs pass. | Implemented; remote workflows have not been triggered. |
| A11 — visual hierarchy | Shared heights/spacing, neutral pane surfaces, compact gutter/status, honey identity. Real article light/dark matrix and eight reviewed baselines, narrow PDF waits and page ARIA grouping pass. | Reviewed locally on the pinned browser/font runner. |

Existing regression gates include 14 worker-runtime tests, 21 availability/snapshot/history tests, 19 local-compiler/
scheduler tests, browser history restoration and the three-client concurrent-edit/viewer/member-removal journey.
The no-renderer native background harness also passes two-project text/assets bootstrap, exact device identity on
reattach, worker-crash recovery, persistent pause, restart and logout. Its stale fixture was corrected to join using
the server-assigned full project slug, not the submitted name prefix. [Background evidence](evidence/authoring/background-windows.json).

## Packaged production identity: reproduction and correction (A09)

Built a real optimized **0.9.1 NSIS installer**, without `test-picker` or the E2E identifier, and installed it only inside
Windows Sandbox. The bundled worker self-check passed, establishing that package resources were present. During 12
concurrent launches from two paths, the original app then stalled with two partly constructed native windows and no
tray/worker. [Before-fix evidence](evidence/authoring/packaged-before.json). This was one owning process, not two app
instances: the early single-instance callback reentered window construction while WebView2 was pumping messages.

`show_main` now retains early open requests until app setup has completed, including requests that should reopen a
background launch. It also coalesces reentrant window construction. The first correction exposed a second race on the
third rapid close/reopen: a window could become visible before its replacement WebView/close handlers were ready.
[Reopen reproduction](evidence/authoring/packaged-reopen-before.json). Replacement windows now become visible only
after construction returns. No single-instance identifier, synchronization ownership or installer profile was changed.

The final actual installer passes **7 packaged scenarios**: concurrent cross-path startup and three close/reopen
cycles. Every scenario retains owner PID **21016**, exactly one native `tray_icon_app` window, one bundled Node worker
and the expected visible-main count (zero closed, one open). [Final package evidence](evidence/authoring/packaged-windows.json).
Sandbox WebView2 uses the read-only mapped 155.0.4283.62 runtime. The sandbox was stopped afterward; no host app
installation/profile was used. The pure startup-state regression and existing lifecycle unit tests pass **3/3**.

Installer SHA-256: `142c1fb90cdfc78a1f5679c8e52c46f4eaf1c8ab60142f8a0d054f7ad0a872bf`.
Executable SHA-256: `0de8ee89bf651e69aa7d72ab8a41066ba099a5762b1332604e3ec389cbf9470a`.
This is current startup/lifecycle evidence. Upgrade/uninstall and signed-update acceptance remain the separate release
gates; they were not rerun here. The package is a local test artifact and has not been published.
