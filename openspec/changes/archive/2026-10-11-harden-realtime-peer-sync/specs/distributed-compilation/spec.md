# Spec Delta

## ADDED Requirements

### Requirement: Complete immutable compile inputs
A compile SHALL consume a captured set of available source files, assets, main-file selection, and engine selection. Its result identity SHALL be computed from those exact captured inputs. Missing synchronized content SHALL defer the build or produce an explicit incomplete-input outcome, without substituting empty sources or claiming a current successful result.

#### Scenario: Edit during asset acquisition
- **WHEN** a text file changes while the compiler acquires another input
- **THEN** the completed build identifies the captured inputs it actually used and subsequent edits leave that result stale

#### Scenario: Leader still receiving files
- **WHEN** a newly elected leader has the file table but lacks required source contents
- **THEN** it waits for those contents or reports the unavailable inputs rather than compiling empty stand-ins

### Requirement: Compile settings participate in result identity
Changing the main file or TeX engine SHALL invalidate reuse of a successful result produced with different settings, even when source file bytes are unchanged. The stale indicator SHALL compare against the same input identity used by compilation.

#### Scenario: Switch main document
- **WHEN** an editor selects another main file without editing either file
- **THEN** the next compile uses that file and does not return the previous main file's cached result

#### Scenario: Switch engine
- **WHEN** the project changes from pdfLaTeX to XeLaTeX without a source edit
- **THEN** the prior result is not considered a successful build of the new configuration
