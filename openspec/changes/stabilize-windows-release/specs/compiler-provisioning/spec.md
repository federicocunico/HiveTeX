# Spec Delta

## ADDED Requirements

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
