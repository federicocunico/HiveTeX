# Spec Delta

## ADDED Requirements

### Requirement: Local tests do not depend on the host firewall
Automated tests that run on one machine SHALL bind listening sockets and gather connection candidates only on loopback,
so they trigger no firewall prompt. Their result SHALL NOT depend on whether a prompt was answered. Tests that need real
interfaces SHALL be lab tests that are opt-in and say so. A required native test SHALL fail rather than skip silently
when its prerequisite is missing.

#### Scenario: Running the Rust and sync suites with the firewall enabled
- **WHEN** the Rust library tests and the sync suite run on Windows with the firewall enabled and nobody at the keyboard
- **THEN** no firewall prompt appears, no new inbound rule is created, and the results equal those with the firewall disabled

#### Scenario: Native bridge missing locally
- **WHEN** the native RTC tests run without a built bridge and the native tests are not explicitly opted out
- **THEN** the run reports them as skipped by name with the command that enables them, or fails, and does not report a silent pass

### Requirement: Two-machine sync verification controls the firewall
The two-machine sync test SHALL establish and record the firewall state of both machines before any sync step. The
remote machine's firewall SHALL be disabled unless a scenario injects a firewall fault. Such a fault SHALL be checked to
be in effect. On the host, the test SHALL fail at once with a firewall diagnosis when an enabled profile could block it.

#### Scenario: Sandbox firewall
- **WHEN** a scenario without a firewall fault starts
- **THEN** the sandbox firewall is disabled for all profiles, the state is verified and saved in the results, and a failure to disable it stops the run with a firewall diagnosis

#### Scenario: Host firewall could block inbound traffic
- **WHEN** the host profile facing the sandbox is enabled and has no inbound allow rule for the exact app and server executables used
- **THEN** the run stops before signing in with a message naming the profile, the executables and how to allow them, and reports no sync failure

#### Scenario: Injected no-UDP fault
- **WHEN** the no-UDP scenario runs
- **THEN** the run verifies that UDP from the sandbox app is blocked and that the session uses the relay, and fails if the fault did not take effect

### Requirement: Two-machine reachability before sync
Before the apps sign in, the two-machine test SHALL check that the sandbox reaches the host server over TCP and that UDP
passes between the machines. It SHALL record the result. A reachability failure SHALL be reported as such, not as a
sync or connection failure of the app.

#### Scenario: UDP blocked between machines
- **WHEN** the UDP check between host and sandbox fails in a scenario that expects UDP
- **THEN** the run stops with a reachability diagnosis and the observed firewall state, without running sync steps

### Requirement: Two-machine data-safety scenarios
The two-machine sync test SHALL be able to verify, between desktop apps and between a browser and a desktop app:
- text and binary assets, compared by tree and byte hash;
- concurrent rename and delete;
- offline edits on both sides;
- a forced crash and restart;
- the original author of each change;
- a full recovery export from each side.

Each scenario SHALL record its result and trace.

#### Scenario: Offline on both sides
- **WHEN** both machines lose connectivity, each edits and deletes files, and connectivity returns
- **THEN** both trees and byte hashes converge, every deleted or conflicting version is listed in Recovery on both sides, and each change names its original author

#### Scenario: Crash during editing
- **WHEN** the sandbox app is killed during a burst of edits and restarted
- **THEN** every edit acknowledged before the kill is present after restart on both machines

### Requirement: Isolated desktop test builds
Desktop test builds SHALL use their own build output and app identity, separate from development and installed builds.
Test harnesses SHALL check that no previous test instance is running before launch. They SHALL close apps gracefully
before forcing termination, and SHALL let the build output and results be placed on a chosen volume.

#### Scenario: Leftover test instance
- **WHEN** a previous test run left the test app running and a new run starts
- **THEN** the new run stops it or fails with a message naming the leftover process, and does not drive the old build

#### Scenario: Development app open during tests
- **WHEN** a developer runs the desktop tests while the installed app is open
- **THEN** both run side by side as different apps and the test build never replaces the development or installed executable
