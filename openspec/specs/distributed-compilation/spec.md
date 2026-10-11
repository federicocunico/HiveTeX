# distributed-compilation Specification

## Purpose

Produces the project PDF on the most capable connected member device and delivers it to everyone, so no central compile server is needed and weaker laptops are spared, with automatic hand-over when that device leaves.

## Requirements

### Requirement: Compile capability advertisement
Every connected device SHALL advertise a compile capability record including: whether it can compile at all, engine kind (native TeX or in-browser), a measured performance score, power state (mains/battery), current load, and an opt-out flag. The record SHALL be refreshed when it changes materially.

#### Scenario: Laptop unplugged
- **WHEN** a device switches from mains to battery power
- **THEN** its updated capability record reaches all peers within 5 seconds

#### Scenario: User opts out
- **WHEN** a user disables "compile for others" in settings
- **THEN** that device is never elected compile leader

### Requirement: Compile leader election
The connected peers SHALL agree on exactly one compile leader per project: the eligible device with the highest capability score, ties broken deterministically. Native engines SHALL outrank in-browser engines; battery-powered devices SHALL be penalized.

#### Scenario: Desktop and laptops online
- **WHEN** a mains-powered desktop with native TeX and two battery laptops are connected
- **THEN** all three devices agree that the desktop is the compile leader

#### Scenario: Network partition
- **WHEN** the mesh splits into two groups that cannot reach each other
- **THEN** each group elects its own leader, and after reunion a single leader remains

### Requirement: Leader failover
When the compile leader disconnects, stops responding or becomes ineligible, the next-best eligible device SHALL become leader without user action.

#### Scenario: Leader shuts down
- **WHEN** the leader device is turned off
- **THEN** a new leader is elected within 10 seconds and the next compile runs there

### Requirement: Automatic compilation
The leader SHALL compile the project automatically after edits settle (debounced), and on explicit request from any member. A newer request SHALL supersede a compile that is still pending for an older state. Explicit requests SHALL be throttled per requesting peer, and a request for an unchanged project state SHALL NOT start a new build.

#### Scenario: Typing pause
- **WHEN** an editor stops typing for the debounce interval
- **THEN** the leader compiles the latest merged state and all members receive the new PDF

#### Scenario: Viewer requests compile
- **WHEN** a viewer clicks "Recompile"
- **THEN** the leader compiles and all members, including the viewer, receive the result

#### Scenario: Request flood
- **WHEN** a peer sends hundreds of recompile requests within a few seconds
- **THEN** the leader runs at most one build for that peer's requests in that interval

#### Scenario: Nothing changed
- **WHEN** a recompile is requested and the project state equals the state of the last successful build
- **THEN** the leader re-sends the last result instead of compiling again

### Requirement: Compilation result distribution
The leader SHALL send each successful result (PDF and source-position mapping data) to all connected members, tagged with the document state it was compiled from. Failed compiles SHALL distribute the log and parsed errors/warnings.

#### Scenario: Successful compile
- **WHEN** the leader finishes a compile
- **THEN** every connected member's preview shows the new PDF and states which edit state it reflects

#### Scenario: Compile error
- **WHEN** the source has a LaTeX error
- **THEN** every member sees the error list with file and line, and the last good PDF stays visible

### Requirement: Source/PDF navigation
Members SHALL be able to jump from a source position to the matching PDF location and from a PDF location back to source, using the leader-produced mapping data.

#### Scenario: Reverse search
- **WHEN** a member double-clicks a paragraph in the PDF preview
- **THEN** the editor opens the corresponding file and line

### Requirement: Compile isolation and safety
Compilation MUST run with shell-escape disabled and with file access restricted to the project's working copy and the TeX distribution, and MUST be time- and memory-limited.

#### Scenario: Malicious shell-escape
- **WHEN** a source file uses `\write18` or `\immediate\write18` to run a command
- **THEN** the command is not executed on the leader's machine

#### Scenario: Infinite loop
- **WHEN** a document causes the engine to loop
- **THEN** the compile is aborted after the time limit and an error is reported

#### Scenario: Build tool configuration in the project
- **WHEN** a project contains a `latexmkrc` or `.latexmkrc` file with commands
- **THEN** the leader's build tool does not read it and no command from it is executed

#### Scenario: Reading files outside the project
- **WHEN** a source file uses `\input` or `\includegraphics` with an absolute path or a path leaving the working copy, on any supported distribution (TeX Live, MiKTeX, MacTeX)
- **THEN** the file is not read and its content does not appear in the PDF or the log

### Requirement: Engine selection
Projects SHALL let editors choose the TeX engine (pdfLaTeX, XeLaTeX, LuaLaTeX where available) and main file. Devices that do not support the chosen engine SHALL be ineligible for leadership. A device SHALL only advertise engines it can actually run with the compile isolation guarantees.

#### Scenario: XeLaTeX project
- **WHEN** a project uses XeLaTeX and one peer's engine does not support it
- **THEN** that peer is not elected leader

#### Scenario: Tectonic-only device
- **WHEN** the only TeX engine on a desktop device is Tectonic
- **THEN** the device advertises no engine, is never elected leader, and its user is told to install TeX Live, MiKTeX or MacTeX to compile on that device

### Requirement: Local compile override
Any member SHALL be able to compile locally on their own device regardless of leadership, without distributing the result.

#### Scenario: Offline compile
- **WHEN** an editor is offline and clicks "Compile locally"
- **THEN** their own device produces the PDF if it has a supported engine

### Requirement: Per-device compiler preference
Each device SHALL let its user choose how documents are compiled:
- **Automatic** (default): the device compiles for the project when it is the best available, unless the user opted
  out of compiling for others; otherwise it shows the result produced by the leader.
- **Use peers:** the device never compiles and is never eligible as leader. It needs no TeX installation and does not
  download an in-browser compiler; it shows the leader's results.
- **This device only:** the device compiles locally after edits settle and shows its own result. It is never eligible as
  leader, and its results are not sent to others.

The preference SHALL apply to every project on the device, persist across restarts, and take effect without reopening
the project. The workspace SHALL show the active preference and which device produced the visible PDF.

#### Scenario: No LaTeX installed
- **WHEN** a member without a TeX installation chooses *Use peers* and a co-author's device can compile
- **THEN** the member sees the PDFs compiled by that device, and nothing is compiled or downloaded on their own device

#### Scenario: No peer can compile
- **WHEN** a member uses *Use peers* and no connected device can compile
- **THEN** the workspace says that no peer can compile right now and points to the other preferences

#### Scenario: This device only
- **WHEN** a member with TeX installed chooses *This device only* and edits the document
- **THEN** their device compiles and shows its own PDF, and co-authors' leader election and results are unaffected

#### Scenario: Switching takes effect immediately
- **WHEN** the current leader's user switches to *Use peers*
- **THEN** that device stops being leader and the next-best eligible device takes over without anyone reopening the
  project

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
