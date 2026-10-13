# Spec Delta

## MODIFIED Requirements

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
