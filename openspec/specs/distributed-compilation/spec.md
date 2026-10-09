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
The leader SHALL compile the project automatically after edits settle (debounced), and on explicit request from any member. A newer request SHALL supersede a compile that is still pending for an older state.

#### Scenario: Typing pause
- **WHEN** an editor stops typing for the debounce interval
- **THEN** the leader compiles the latest merged state and all members receive the new PDF

#### Scenario: Viewer requests compile
- **WHEN** a viewer clicks "Recompile"
- **THEN** the leader compiles and all members, including the viewer, receive the result

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

### Requirement: Engine selection
Projects SHALL let editors choose the TeX engine (pdfLaTeX, XeLaTeX, LuaLaTeX where available) and main file. Devices that do not support the chosen engine SHALL be ineligible for leadership.

#### Scenario: XeLaTeX project
- **WHEN** a project uses XeLaTeX and one peer's engine does not support it
- **THEN** that peer is not elected leader

### Requirement: Local compile override
Any member SHALL be able to compile locally on their own device regardless of leadership, without distributing the result.

#### Scenario: Offline compile
- **WHEN** an editor is offline and clicks "Compile locally"
- **THEN** their own device produces the PDF if it has a supported engine
