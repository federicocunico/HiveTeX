# compiler-provisioning Specification

## Purpose
Gives every device a working LaTeX compiler without a prior installation, downloading only what documents need, and
makes faster or fuller compilers a guided, reversible step, so HiveTeX works as an IDE from the first document.

## Requirements

### Requirement: Quick compiler set up automatically (desktop)
When the desktop app has no TeX installation available and a compile is needed, it SHALL download a compact LaTeX
engine into the app's data folder, show progress, and compile with it, without administrator rights and without a
separate installation step. The engine SHALL be a pinned version verified against its published checksum before use.
Packages SHALL be downloaded the first time a document needs them, at build time, and kept on disk for later and
offline builds. The engine SHALL run with shell escape disabled. Time spent downloading packages SHALL NOT count toward
the build's time limit, within an overall cap after which the build is stopped.

#### Scenario: First compile without LaTeX
- **WHEN** a desktop user without any TeX installation compiles a document for the first time
- **THEN** the status bar shows the compiler being set up with progress, and the PDF appears without the user
  installing anything

#### Scenario: Slow first build
- **WHEN** the quick compiler's first build spends longer than the build time limit downloading the files it needs,
  and keeps receiving them
- **THEN** the build is not stopped for taking too long, and the PDF appears once compiling finishes

#### Scenario: Build stuck without downloading
- **WHEN** a quick-compiler build runs past the build time limit without downloading anything, or past the overall cap
- **THEN** it is stopped and reported as timed out

#### Scenario: A package used for the first time
- **WHEN** a document adds `\usepackage{siunitx}` and the quick compiler has not used siunitx before
- **THEN** siunitx is downloaded during that build, the build succeeds, and the next build does not download it again

#### Scenario: Corrupted engine download
- **WHEN** the downloaded engine archive does not match its checksum
- **THEN** it is deleted, nothing is installed, and the compile reports that the compiler download failed and can be
  retried

### Requirement: Full LaTeX installed on request (desktop)
The desktop app SHALL offer to install a compact full LaTeX distribution into the app's data folder, without
administrator rights and without changing any system-wide TeX installation, verified against its published checksum,
with progress shown. Once installed it SHALL be preferred over the quick compiler. The user SHALL be able to remove it.

#### Scenario: Install full LaTeX
- **WHEN** a user chooses *Install full LaTeX*
- **THEN** the distribution is downloaded with progress, verified, unpacked into the app's data folder, and the next
  compile uses it

#### Scenario: Remove
- **WHEN** the user removes the installed distribution
- **THEN** its folder is deleted and the quick compiler is used again

### Requirement: Missing packages installed on demand (managed full LaTeX)
When a compile with the app-managed full LaTeX distribution fails because a package file is missing, the app SHALL
install the package providing it into that distribution and compile again, showing which package is being installed.
It SHALL NOT install packages into a TeX installation it did not install itself.

#### Scenario: New package
- **WHEN** a document uses `\usepackage{tikz-cd}` and the managed distribution does not have it
- **THEN** the app shows "Installing package tikz-cd", installs it, and the compile succeeds

#### Scenario: System TeX Live
- **WHEN** the user's own TeX Live installation is used and a package is missing
- **THEN** the compile reports the missing package and nothing is installed into that installation

### Requirement: Local compile helper for the web app
While the desktop app runs, it SHALL offer a compile service on the local machine that the HiveTeX web app can use to
compile with the desktop's compiler. The service SHALL listen only on the loopback interface. It SHALL accept requests
only from the configured HiveTeX web origin and only with a token obtained by pairing, which the user confirms in the
desktop app. The user SHALL be able to turn the service off and revoke pairings. When paired and reachable, the web app
SHALL compile through it. The helper SHALL build only on the same machine as the browser; no compile capability or result SHALL be advertised or sent to co-authors.

#### Scenario: Pairing
- **WHEN** a signed-in web user with the desktop app running chooses *Compile with my desktop app*
- **THEN** the desktop app asks the user to allow it, and after confirmation the web app compiles through the desktop

#### Scenario: Not paired yet
- **WHEN** a web user who never chose *Compile with my desktop app* opens a project
- **THEN** the web app does not contact the local service (browsers may ask permission to reach local apps)

#### Scenario: Another website
- **WHEN** a page from another origin, or a request without a valid pairing token, calls the local service
- **THEN** the request is refused and nothing is compiled

#### Scenario: Desktop app closed
- **WHEN** the paired desktop app is not running
- **THEN** the web app falls back to its in-browser engine or reports that no local engine is available, and never requests a build from peers

### Requirement: In-browser compiler as fallback, with kept files
When no native compiler or local helper is available, the app SHALL use the built-in in-browser compiler if its required files are cached or obtainable. Downloaded TeX files SHALL be kept and reused offline where supported. A failed upstream reachability probe SHALL NOT disable an otherwise complete local cache. Users SHALL be able to inspect and clear compiler caches.

#### Scenario: Second compile
- **WHEN** a web user on Chrome compiles the same document again later
- **THEN** no TeX file already downloaded is fetched again

#### Scenario: Package server down and nothing else available
- **WHEN** required compiler files cannot be obtained from cache or the package server, and there is no local native compiler or helper
- **THEN** the workspace says no compiler is available, and suggests local compiler setup or obtaining the missing packages

#### Scenario: Warm cache while offline
- **WHEN** the browser reopens an available workspace offline with the required engine and package files cached
- **THEN** the app attempts a local build using those files and reports any missing dependency without contacting peer compilers

### Requirement: Compiler state is visible
The app SHALL show which compiler a device uses (system TeX, full LaTeX, quick compiler, desktop helper, in-browser,
peers) and its state: ready, setting up (with progress), downloading or installing packages (naming them), or
unavailable. Compile failures caused by a package that could not be obtained SHALL name the package and suggest the next
step, in addition to the raw log.

#### Scenario: Status while setting up
- **WHEN** the quick compiler is being downloaded
- **THEN** the status bar shows "Setting up the compiler" with progress, then the compiler's name once ready

#### Scenario: Package that cannot be obtained
- **WHEN** a build fails because a package could not be downloaded or does not exist
- **THEN** the result names the package and suggests checking the name, the connection, or full LaTeX

### Requirement: Coherent compiler selection
The desktop SHALL select tools from one working TeX installation, prefer managed full LaTeX when installed, and skip system candidates whose version probe fails or exceeds a bounded deadline. It SHALL NOT combine engines and build tools from different PATH entries. A failed system probe SHALL permit selection of another working installation or the managed quick compiler.

#### Scenario: Several system versions installed
- **WHEN** PATH contains stale MiKTeX tools followed by a working TeX Live installation
- **THEN** failed probes are skipped and engines, latexmk and package lookups use the same selected installation

#### Scenario: Managed full LaTeX installed beside system versions
- **WHEN** full LaTeX is installed in the app and PATH contains older system TeX versions
- **THEN** new builds select managed full LaTeX

#### Scenario: Hung system version check
- **WHEN** a system version probe never exits
- **THEN** detection ends within its deadline, terminates the probe and can fall back to the managed compiler

### Requirement: Complete compiler-cache reset
Account > Compiler SHALL offer a desktop cache reset that removes build artifacts, downloaded quick-compiler packages, transient compiler downloads and in-browser TeX files, forgets compiler detection and reports completion or an actionable error. Installed compilers, documents, sessions, preferences and external folders SHALL be preserved. Reset SHALL refuse while a compile, installation or compiler removal is active.

#### Scenario: Reset after installing several app versions
- **WHEN** the user clears compiler caches with retained projects and compilers installed
- **THEN** compiler caches are removed and subsequent builds reconstruct them while documents and installed compilers remain

#### Scenario: Reset requested during a build
- **WHEN** a compile is using the compiler cache
- **THEN** reset reports that the user must wait and does not delete files

#### Scenario: Cache removal denied
- **WHEN** a cached file cannot be deleted
- **THEN** reset reports the filesystem failure rather than claiming success

### Requirement: Compiler results stay on this machine
All compiler results SHALL stay on the machine that built them. The quick compiler SHALL compile the local project automatically when enabled, and never participate in peer builds. Its file-read limitations SHALL remain visible; they SHALL NOT permit sharing PDFs, logs or mappings with co-authors.

#### Scenario: Collaborator tries to read a local file
- **WHEN** a co-author's source contains `input{C:/Users/alice/secret.txt}` and Alice's device compiles with the quick
  compiler
- **THEN** the resulting PDF stays on Alice's device and is never sent to the co-author

#### Scenario: Different local compilers
- **WHEN** one member has full TeX and another only the quick compiler
- **THEN** each member compiles and sees only their own local result

#### Scenario: Project opened with only the quick compiler
- **WHEN** a desktop user whose only compiler is the quick compiler opens a project and does not edit it
- **THEN** their device compiles the project once it is ready and shows the PDF, without waiting for an edit

#### Scenario: Compile requested with co-authors online
- **WHEN** a user whose only compiler is the quick compiler clicks Compile while co-authors are connected
- **THEN** their device compiles the project and shows its own PDF, and nothing is sent to the co-authors

#### Scenario: Quick compiler installed while the project is open
- **WHEN** the quick compiler finishes installing (automatically or from Account > Compiler) while a project is open
- **THEN** the project is compiled on this device without reopening it

#### Scenario: Status of a quick-compiler device
- **WHEN** a device compiles with the quick compiler and local automatic compilation is enabled
- **THEN** the status bar says the project compiles only on this device with the quick compiler, and never says that no
  compiler is available

### Requirement: Compiler status follows the active engine
The compiler status in the workspace SHALL change whenever the engine used for builds changes, including after pairing
the desktop helper. It SHALL NOT keep offering setup while builds succeed.

#### Scenario: Pairing the desktop helper
- **WHEN** a web member pairs the desktop helper and the next build uses it
- **THEN** the status bar names the helper without a reload, and does not show "Set up a local compiler"
