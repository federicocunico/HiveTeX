# Spec Delta

## MODIFIED Requirements

### Requirement: Local compile override
Any member SHALL be able to compile locally on their own device regardless of leadership, without distributing the result.
An explicit compile request SHALL also build on the requesting device, without distributing the result, when that
device shows only its own results or when no connected device leads and that device has a compiler.

#### Scenario: Offline compile
- **WHEN** an editor is offline and clicks "Compile locally"
- **THEN** their own device produces the PDF if it has a supported engine

#### Scenario: Nobody leads, co-authors connected
- **WHEN** an editor whose device has a compiler but is not eligible as leader clicks Compile, and the connected
  co-authors cannot compile either
- **THEN** their own device produces the PDF instead of the request going unanswered

#### Scenario: A leader exists
- **WHEN** an editor in *Automatic* clicks Compile while another device leads
- **THEN** the leader compiles and the editor's device does not start a build of its own

## ADDED Requirements

### Requirement: Compile indicator reflects the effective policy
The workspace's "who compiles" indicator SHALL reflect how this device actually takes part in compilation, including
when its compiler forces builds to stay local, rather than only the stored preference. It SHALL say that no compiler is
available only when neither this device nor any connected device can compile, and SHALL say a compiler is being set up
while that is in progress.

#### Scenario: Local-only compiler under Automatic
- **WHEN** the stored preference is *Automatic* and this device's compiler keeps builds local
- **THEN** the indicator says the project compiles only on this device

#### Scenario: Compiler being set up
- **WHEN** this device is still downloading or preparing its compiler and no other device leads
- **THEN** the indicator says the compiler is being set up, not that none is available

#### Scenario: Truly no compiler
- **WHEN** this device has no compiler and no connected device can compile
- **THEN** the indicator says no compiler is available and the workspace suggests how to get one
