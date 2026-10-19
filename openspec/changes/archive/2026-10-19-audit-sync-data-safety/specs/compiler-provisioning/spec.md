# Spec Delta

## REMOVED Requirements

### Requirement: Quick-compiler builds stay on the device
**Reason**: Local-only output is now required for every compiler; the former exception allowing shared builds is removed.
**Migration**: Use Compiler results stay on this machine and local-compilation. All six former user flows remain covered with local-only results; peer build support is removed.

## ADDED Requirements

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

## MODIFIED Requirements

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




