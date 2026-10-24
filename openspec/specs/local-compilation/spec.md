# local-compilation Specification

## Purpose
Builds each member's PDF exclusively on that member's machine, independently of peer compiler availability, while preserving source synchronization and coherent local results.

## Requirements

### Requirement: Exclusively local builds
Every automatic or requested build SHALL execute on the requesting member's machine using its desktop compiler, in-browser engine or paired loopback helper. Clients SHALL NOT elect compile leaders, advertise compile capacity, request builds from peers or publish generated PDFs, logs or source-position mappings to peers.

#### Scenario: Two connected co-authors
- **WHEN** Alice and Bob edit the same project with automatic compilation enabled
- **THEN** their sources synchronize and each machine builds and displays its own PDF, which may differ if local compiler environments differ

#### Scenario: Legacy peer sends a build message
- **WHEN** an older peer sends compile capabilities, requests or results
- **THEN** the current client ignores those messages, does not build for the peer and does not accept its result as the local preview

#### Scenario: PDF used as an input asset
- **WHEN** an editor intentionally adds a PDF as a project source asset
- **THEN** that asset synchronizes normally; generated build outputs are not automatically added to the source tree or sync asset store

### Requirement: Local build scheduling
Each foreground workspace SHALL support explicit local builds and automatic local compilation after edits settle. Source changes received from peers SHALL schedule a local build when automatic compilation is enabled. Requests for unchanged inputs SHALL reuse the local successful result; overlapping requests SHALL coalesce and retain a request for the latest inputs. Members SHALL choose After changes, Periodic or Manual scheduling. After changes SHALL be the default, scheduling after 1500 ms of inactivity or 5000 ms of continuous changes. Periodic SHALL check changed inputs at the selected interval. Manual SHALL start no automatic builds.

#### Scenario: Remote source edit
- **WHEN** an authenticated peer's edit reaches an open project with automatic compilation enabled
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

### Requirement: Local operation without peers
A complete project with an installed or sufficiently cached compiler and required packages SHALL compile without peer connections or control-plane access. Missing sources or compiler dependencies SHALL produce an explicit recoverable failure, without empty stand-ins, source changes or loss of the last good PDF.

#### Scenario: Offline after restart
- **WHEN** a member reopens a complete local project while offline with all compiler dependencies available
- **THEN** clicking Compile produces a real PDF without requiring a reachability probe, ticket refresh or peer response to succeed

#### Scenario: Package unavailable offline
- **WHEN** a build needs a package not stored on this machine
- **THEN** the local failure identifies the unavailable dependency and a later retry can succeed after it becomes available

### Requirement: Captured local build identity
Each build SHALL use one immutable capture of complete sources, assets, main-file selection and engine selection. Its result SHALL identify those exact inputs. Changing any input SHALL make an older preview stale. Missing content SHALL defer the build or return an explicit incomplete outcome.

#### Scenario: Edit during asset acquisition
- **WHEN** a text file changes while a captured build fetches another input from peers
- **THEN** the result identifies the capture it built, remains stale for the newer sources and does not claim to contain the later edit

#### Scenario: Settings change
- **WHEN** the main file or engine changes without a text edit
- **THEN** the next request builds that configuration and cannot reuse a result with different settings

### Requirement: Local result and navigation
The workspace SHALL display only local build results, parsed diagnostics and source-position mappings. It SHALL show the active local compiler, build progress and whether its PDF matches current inputs. A failed build SHALL preserve the last good PDF. Source/PDF navigation SHALL use mappings from that displayed local build.

#### Scenario: LaTeX error then correction
- **WHEN** a source error makes a local build fail and the member corrects it
- **THEN** the error and stale preview are visible until a successful local build replaces them

#### Scenario: Reverse search
- **WHEN** a member double-clicks a paragraph in the locally generated PDF
- **THEN** the editor opens the matching source file and line using that build's mapping

### Requirement: Bounded local compiler failure
Local startup and execution SHALL have finite deadlines and recoverable failure states. Startup silence, worker crashes, cancellation and missing dependencies SHALL settle pending actions with a visible cause. A retry SHALL use a usable compiler instance without reopening the project or altering sources.

#### Scenario: Worker never starts
- **WHEN** the browser compiler emits neither readiness nor an error
- **THEN** startup fails at its deadline and a later request can start a fresh worker

#### Scenario: Worker crashes during a build
- **WHEN** the compiler worker exits unexpectedly
- **THEN** the build fails within its deadline, the previous PDF remains visible and retry can create a new worker

### Requirement: Local engine selection and isolation
Editors SHALL choose the project main file and TeX engine. Devices SHALL run only locally supported engines and explain missing support. Builds MUST disable shell escape, ignore executable project build configuration and enforce time and memory limits. Engines able to restrict file reads MUST confine reads to project inputs and distribution files; exceptions MUST be disclosed before use.

#### Scenario: Unsupported engine
- **WHEN** a project selects LuaLaTeX on a device whose engine does not support it
- **THEN** that device reports local incompatibility and offers a compatible local installation without delegating the build

#### Scenario: Shell escape or project configuration
- **WHEN** source uses shell escape or a project supplies executable latexmk configuration
- **THEN** no project-supplied command is executed on the user's machine

#### Scenario: Infinite loop
- **WHEN** a document runs indefinitely
- **THEN** the compiler process tree or worker is terminated at its limit with an explicit failure

#### Scenario: External file on a restricted engine
- **WHEN** a source attempts to read outside project inputs and distribution directories using an engine that supports confinement
- **THEN** the read is refused and no such content appears in the PDF or log

### Requirement: Migration from shared compilation
Stored shared or peer-only compile modes SHALL migrate to local compilation with a one-time explanation. Local builds SHALL be the only available mode; existing automatic compilation preferences SHALL remain local. Builds SHALL NOT be silently delegated when this machine has no engine. Existing source data, project history and last local successful result SHALL remain available.

#### Scenario: Former Use peers preference
- **WHEN** a member upgrades with a stored peer-only or shared preference
- **THEN** the workspace explains that shared compilation was removed, selects local builds and offers local setup if needed

#### Scenario: Existing local user
- **WHEN** a member upgrades from the existing local default
- **THEN** builds remain local without a redundant migration notice or source changes

### Requirement: Compiler resources end with the session
Closing a project SHALL stop its builds and release the compiler workers and processes started for it. Cancelling a
native build SHALL stop the compiler process.

#### Scenario: Reopening projects repeatedly
- **WHEN** a member opens and closes ten projects in the web app
- **THEN** no compiler worker from a closed project remains running

#### Scenario: Cancelled native build
- **WHEN** a running native build is cancelled, for example because its project is closed
- **THEN** its compiler process tree ends and a later build starts without waiting for the old one to finish

### Requirement: Outputs from shared builds are not offered to peers
Generated PDF, log and SyncTeX files that a previous release stored as shared assets SHALL NOT be announced or served
to peers. Assets the project references as inputs SHALL continue to synchronize.

#### Scenario: Project used with shared builds on 0.8.0
- **WHEN** an upgraded member opens a project whose store holds PDFs produced by a former build leader
- **THEN** those generated files are not announced to joining peers, while an uploaded `figure.pdf` used by `\includegraphics` still syncs

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
