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

### Requirement: Quick-compiler builds stay on the device
Because the quick compiler cannot prove which files a document read, builds made with it SHALL stay on the device that
made them: the device SHALL compile its own copy of the project automatically, SHALL NOT be eligible as the project's
compile leader, and SHALL NOT send its results to others. Shared builds SHALL come only from compilers whose file reads
are verified (a system TeX installation or the app-managed full LaTeX).

#### Scenario: Collaborator tries to read a local file
- **WHEN** a co-author's source contains `input{C:/Users/alice/secret.txt}` and Alice's device compiles with the quick
  compiler
- **THEN** the resulting PDF stays on Alice's device and is never sent to the co-author

#### Scenario: Shared builds still work
- **WHEN** one member has full TeX and another only the quick compiler
- **THEN** the member with full TeX leads and shares PDFs, and the other member sees its own local builds

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
- **WHEN** a device compiles with the quick compiler and its stored preference is *Automatic*
- **THEN** the status bar says the project compiles only on this device with the quick compiler, and never says that no
  compiler is available

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
SHALL compile through it. The web app SHALL advertise a compiler to co-authors only when the desktop's compiler verifies
file reads; otherwise the helper's builds stay in that user's browser.

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
- **THEN** the web app falls back to the in-browser engine or to peers, and says which is used

### Requirement: In-browser compiler as fallback, with kept files
When no native compiler or local helper is available, the app SHALL use the built-in in-browser compiler while its
package server is reachable. TeX files it downloads SHALL be kept on the device and reused, including offline, where the
platform allows it (desktop; Chromium-based browsers). The user SHALL be able to see the space used and clear it.

#### Scenario: Second compile
- **WHEN** a web user on Chrome compiles the same document again later
- **THEN** no TeX file already downloaded is fetched again

#### Scenario: Package server down and nothing else available
- **WHEN** the in-browser compiler's package server cannot be reached, and there is no native compiler, helper or
  peer that can compile
- **THEN** the workspace says no compiler is available, and suggests the desktop app or a co-author who can compile

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
