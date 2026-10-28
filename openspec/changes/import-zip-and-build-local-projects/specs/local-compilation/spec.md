# Spec Delta

## MODIFIED Requirements

### Requirement: Local operation without peers
A complete project with an installed or sufficiently cached compiler and required packages SHALL compile without peer connections or control-plane access. Local inputs SHALL be restored before attempting peer acquisition; peer presence SHALL NOT gate complete local inputs. Missing sources or compiler dependencies SHALL produce an explicit recoverable failure, without empty stand-ins, source changes or loss of the last good PDF.

#### Scenario: Offline after restart
- **WHEN** a member reopens a complete local project while offline with all compiler dependencies available
- **THEN** clicking Compile produces a real PDF without requiring a reachability probe, ticket refresh or peer response to succeed

#### Scenario: Package unavailable offline
- **WHEN** a build needs a package not stored on this machine
- **THEN** the local failure identifies the unavailable dependency and a later retry can succeed after it becomes available

#### Scenario: Locally supplied project
- **WHEN** a project has just been initialized from a local ZIP or folder with all sources and compiler dependencies available and zero connected peers
- **THEN** compiling uses the local file list, text, and assets and does not report the file list as unavailable

#### Scenario: Older locally initialized project
- **WHEN** an affected v0.10.0 project has recoverable local sources and reliable evidence of complete local initialization
- **THEN** opening it restores local build readiness without requiring a co-author, changing source contents, or discarding history

#### Scenario: Remote input has never arrived
- **WHEN** a joined replica lacks a source that is neither in local storage nor in an available local source
- **THEN** the build identifies that missing input and does not substitute an empty file or claim the project is complete

## ADDED Requirements

### Requirement: Input failures explain local recovery
Input failures SHALL distinguish local loading or storage failures from content that has never arrived. Recovery SHALL offer applicable local retry or source restoration; synchronization SHALL be proposed only for inputs a peer can supply. A complete local project SHALL NOT be instructed to reconnect to a co-author to enable compilation.

#### Scenario: Local storage cannot be read
- **WHEN** build preparation fails to read project storage
- **THEN** the problem identifies local storage and offers retry or source restoration rather than presenting co-author connection as the required fix

#### Scenario: Peer can supply absent content
- **WHEN** a joined project lacks remote source content
- **THEN** the problem identifies the absent content and offers synchronization alongside applicable local source restoration

#### Scenario: Actual TeX or dependency error
- **WHEN** all project inputs are present but the local compiler fails on a source error or missing package
- **THEN** the problem reports that compiler or source cause rather than an unavailable file list
