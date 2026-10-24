# Spec Delta

## MODIFIED Requirements

### Requirement: Local build scheduling
Each foreground workspace SHALL support explicit local builds and automatic local compilation after edits settle. Source changes received from peers SHALL schedule a local build when automatic compilation is enabled. Requests for unchanged inputs SHALL reuse the local successful result; overlapping requests SHALL coalesce and retain a request for the latest inputs. Members SHALL choose After changes, Periodic or Manual scheduling. After changes SHALL be the default, scheduling after 1500 ms of inactivity or 5000 ms of continuous changes. Periodic SHALL check changed inputs at the selected interval. Manual SHALL start no automatic builds.

#### Scenario: Remote source edit
- **WHEN** an authenticated peer's edit reaches an open project with After changes enabled
- **THEN** this device schedules the changed local sources after the debounce interval without requesting a peer build

#### Scenario: Viewer requests compile
- **WHEN** a viewer clicks Compile
- **THEN** their own machine builds its available project copy without changing sources or asking another device to compile

#### Scenario: Seed in the background
- **WHEN** a dormant or background-only seed receives an edit
- **THEN** synchronization continues without starting a compiler or downloading a compiler solely for seeding

#### Scenario: Continuous typing
- **WHEN** source changes continue for more than 5000 ms with After changes enabled
- **THEN** a local build is requested by that maximum wait, or one pending request is retained if another build is running

#### Scenario: Periodic dirty check
- **WHEN** Periodic is set to 30 seconds and source, input assets or build settings change
- **THEN** a local build is requested at the next interval, unchanged successful inputs are not rebuilt and ticks during a build retain at most one request for current inputs

#### Scenario: Switch to Manual while waiting
- **WHEN** a member selects Manual before an automatic request starts
- **THEN** the pending automatic request is discarded, an already running build can finish and later edits require Compile now

#### Scenario: Explicit request during an automatic build
- **WHEN** a member invokes Compile now while an automatic build runs and inputs have changed
- **THEN** no second build runs concurrently and one subsequent build uses the latest complete inputs

## ADDED Requirements

### Requirement: Bounded automatic retry
An automatic build failure SHALL NOT cause repeated builds of the same inputs and compiler environment. A source or setting change, newly available dependency, compiler recovery or explicit retry SHALL permit another attempt. Closing the workspace SHALL discard automatic timers and pending requests. Unavailable inputs SHALL remain distinguishable from empty files.

#### Scenario: Unchanged invalid source
- **WHEN** a periodic build fails with a syntax error and no inputs change
- **THEN** later ticks do not repeat the same failing build; correcting the source or selecting Retry permits another build

#### Scenario: Missing image arrives
- **WHEN** an automatic build is blocked by an unavailable image and synchronization supplies that image
- **THEN** an enabled automatic mode can retry with the complete inputs without requiring an unrelated source edit

#### Scenario: Close with queued work
- **WHEN** a project closes with a build queued or running
- **THEN** the queued build is discarded, the running work is cancelled and later events do not restart its compiler

### Requirement: Actionable local build state
The workspace SHALL distinguish waiting, building, dependency setup, successful output, outdated output and failure. A failure SHALL expose its cause and an applicable recovery action without requiring raw-log inspection. It SHALL retain the last good PDF and never claim success solely because that PDF exists. Missing compiler support SHALL be reported without peer delegation.

#### Scenario: Compiler absent
- **WHEN** the selected engine is unavailable on this device
- **THEN** the workspace identifies the engine, offers local setup or compatible local engine selection and shows no success or "No problems" indicator

#### Scenario: Source error followed by correction
- **WHEN** a build fails at a source location and the member corrects it
- **THEN** the error links to that location and clears after a successful current build; the previous PDF remains visibly outdated until replaced

#### Scenario: Dependency failure without a source line
- **WHEN** package acquisition fails without a source-location diagnostic
- **THEN** a visible summary identifies the missing dependency or acquisition failure and offers retry or compiler setup, with the raw log available for detail

### Requirement: Built-in templates compile with supported local engines
An advertised supported local engine SHALL compile the built-in article and report templates, including their bibliography and input assets, into real PDFs with resolved references after required dependencies are available. Compiler formats and package resources SHALL be compatible. Unsupported combinations SHALL be identified explicitly rather than reported as successful builds.

#### Scenario: First build of an article
- **WHEN** a member creates the built-in article with a supported browser or desktop engine and completes necessary dependency setup
- **THEN** compilation produces the typeset article and bibliography, not a rendering of its source commands

#### Scenario: Multi-file report offline
- **WHEN** a report with included chapters, bibliography and an image is reopened offline with its inputs and compiler dependencies cached
- **THEN** a requested build produces a real complete PDF on this device
