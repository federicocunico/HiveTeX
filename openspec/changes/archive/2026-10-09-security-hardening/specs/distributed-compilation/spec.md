# Spec Delta

## MODIFIED Requirements

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
