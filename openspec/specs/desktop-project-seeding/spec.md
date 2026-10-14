# desktop-project-seeding Specification

## Purpose
Keeps authorized local project replicas available to collaborators while the installed desktop application runs without an open editor, with clear controls over lifetime, resources and synchronization.

## Requirements

### Requirement: Desktop application lifetime
Closing the desktop window SHALL keep enabled background synchronization running. The tray SHALL provide Open, Pause all synchronization, Resume synchronization, status and Quit. Explicit Quit SHALL stop networking and exit after attempting durable shutdown. Where a tray cannot be created, closing SHALL leave a recoverable application window and explain the limitation.

#### Scenario: Close while another member edits
- **WHEN** an owner closes the desktop window while another member edits an enabled project
- **THEN** the desktop continues receiving and saving those edits and remains reachable on demand

#### Scenario: Explicit quit
- **WHEN** the member selects Quit
- **THEN** project connections stop, pending edits are flushed, owned mappings are cleaned up and the application exits

#### Scenario: Save failure at quit
- **WHEN** durable shutdown fails while unsaved edits remain
- **THEN** the application exposes the failure and recovery export and requires an explicit discard decision before a user-requested exit loses those edits

#### Scenario: Tray unavailable
- **WHEN** the desktop environment cannot display the tray
- **THEN** closing does not leave an inaccessible hidden application and the user can still pause or quit

### Requirement: Login startup and single instance
The desktop SHALL expose persistent launch-at-login and start-in-background settings. Launch-at-login SHALL require the user's selection. A background launch SHALL restore enabled projects without opening editor windows. A second launch for the same OS user SHALL activate the existing instance rather than create duplicate project connections, including simultaneous startup and launches of different installed versions using the same application identity. Handover SHALL be bounded and SHALL NOT allow a duplicate instance when the first instance is not yet ready or unresponsive.

#### Scenario: Restart the computer
- **WHEN** the user signs in to the OS with launch-at-login and start-in-background enabled
- **THEN** the tray appears and eligible projects resume without editor interaction

#### Scenario: Open an already running app
- **WHEN** the member launches HiveTeX while it is seeding in the tray
- **THEN** the existing window opens and each project still has one network identity

#### Scenario: Concurrent cold launches
- **WHEN** several launches occur before the first app has created its handover window
- **THEN** exactly one app creates a tray and starts its worker, and all secondary processes exit after bounded handover

#### Scenario: Launch from another installation path
- **WHEN** an older or copied HiveTeX executable with the same app identity is launched while the app runs
- **THEN** it hands over to the running instance and creates no additional tray or worker

#### Scenario: Unresponsive primary process
- **WHEN** the primary process cannot acknowledge a second launch
- **THEN** the second launch exits within a bounded deadline without creating another instance

### Requirement: Retained project selection
The desktop SHALL enable seeding by default for shared projects retained locally by the current account with owner/editor rights, subject to a persistent per-project setting. It SHALL offer Download and seed for other joined projects. Local-only projects SHALL never be seeded. A viewer SHALL remain unable to serve authoritative project content.

#### Scenario: Two projects and no workspace
- **WHEN** an editor has two retained shared projects with seeding enabled and returns to the projects page
- **THEN** both remain reachable and synchronize whenever a collaborator connects or rings, without either workspace being open

#### Scenario: Project not downloaded
- **WHEN** an account belongs to a project that has never been retained on this device
- **THEN** its membership alone does not initiate background content downloads

#### Scenario: Viewer copy
- **WHEN** only a viewer's desktop has a cached project
- **THEN** it is not represented as a seed capable of bootstrapping another member

### Requirement: Dormant seeds
An enabled seed SHALL stay dormant, reachable through the doorbell and without control-plane traffic, until a ring, a connected peer or an editor needs it, and SHALL return to dormant when that need ends.

#### Scenario: Collaborator leaves
- **WHEN** the last collaborator connected to a woken seed disconnects and no editor is attached
- **THEN** the seed closes its network activity and waits for the next ring

### Requirement: Editor attachment to persistent synchronization
Opening and closing a desktop workspace SHALL attach and detach its editor without replacing the project's active synchronization runtime. Local edits SHALL retain the existing durability, realtime propagation and offline-merge guarantees across attachment, reload and background operation.

#### Scenario: Reopen during transfer
- **WHEN** a member opens a project while a background binary transfer is in progress
- **THEN** the same transfer continues and the editor observes the same project state without a second peer connection

#### Scenario: Close during opening
- **WHEN** navigation detaches an editor before its asynchronous opening finishes
- **THEN** late completion does not attach stale UI, create duplicate runtimes or restart a stopped project

#### Scenario: Reload the renderer
- **WHEN** the editor renderer reloads while synchronization is active
- **THEN** background synchronization continues and the new renderer reconciles outstanding edits without losing or duplicating them

### Requirement: Complete seed replicas
An enabled seed SHALL fetch and durably retain every known project text document and verified referenced binary within configured limits, without requiring editor access to individual files. Missing or unconfirmed content SHALL remain visibly partial. A disconnected replica SHALL not claim global freshness or advance its successful peer-sync time.

#### Scenario: Seed serves a newcomer
- **WHEN** the original author disconnects after an enabled seed has received a complete project and a new member joins
- **THEN** the seed can supply the file tree, text and binary assets without opening an editor

#### Scenario: Asset unavailable
- **WHEN** one referenced asset cannot be obtained
- **THEN** the seed shows the missing content, continues retrying eligible sources and does not claim a complete replica

### Requirement: Account and authorization boundaries
Background sessions SHALL be scoped to server, account and project. Signing out, switching server/account, entering local mode or receiving authoritative removal SHALL stop affected networking and invalidate delayed work. Expired tickets SHALL stop unauthorized exchange; reconnect SHALL retain the current ticket and epoch checks.

#### Scenario: Sign out with projects seeded
- **WHEN** the member signs out while several projects have pending connection attempts
- **THEN** their connections and retries stop and late callbacks cannot restart them

#### Scenario: Locked credentials at startup
- **WHEN** login startup cannot access the OS credential store
- **THEN** no ephemeral replacement identity is created for seeding and status requests credential access without a retry storm

#### Scenario: Ticket expires during a control-plane outage
- **WHEN** the control plane is unreachable beyond the ticket validity window
- **THEN** unauthorized exchanges stop, local content remains available and authentication is retried without extending ticket validity

### Requirement: Persistent pause and recovery
The desktop SHALL support persistent global and per-project synchronization pause, distinct from disabling only background seeding. Work offline SHALL pause that project across its editor and seed. Unpaused sessions SHALL recover after network changes and OS resume without reopening the editor, with bounded retries and no busy loop.

#### Scenario: Explicit offline choice
- **WHEN** an editor selects Work offline and closes the window
- **THEN** the seed remains disconnected, including after restart, until the member resumes that project

#### Scenario: Background seeding disabled
- **WHEN** a member disables only background seeding for a project
- **THEN** an attached editor may continue normal synchronization and detaching its last editor stops the runtime

#### Scenario: Resume after sleep
- **WHEN** an awake desktop regains a healthy network after sleep
- **THEN** it begins a fresh recovery attempt within 30 seconds, refreshes authorization and connectivity as needed, and reconciles without reopening

### Requirement: Bounded background resources
The desktop SHALL expose limits for concurrently awake background projects, bulk transfer rate and retained storage. Dormant seeds SHALL not count against the awake limit. Queued projects and storage-limited replicas SHALL be visible. Control traffic and foreground edits SHALL take priority over bulk transfers. Limits SHALL never silently delete unshared work, recovery data or a retained seed's required content.

#### Scenario: Active project limit reached
- **WHEN** more projects are enabled than the active limit
- **THEN** excess projects are listed as queued, receive fair scheduling, and are not advertised as currently available seeds

#### Scenario: Disk budget reached
- **WHEN** new binary content would exceed the storage budget
- **THEN** its download waits with a visible storage reason while existing content and unsaved work are retained

#### Scenario: Typing during transfers
- **WHEN** a foreground member edits while background projects receive large assets
- **THEN** bulk transfers yield sufficiently to preserve the existing healthy-connection realtime latency requirement

### Requirement: Background operation visibility
The tray and projects page SHALL distinguish dormant (reachable on ring), waking, seeding, receiving, queued, paused, offline, ring channel unreachable, authentication required, incomplete, relay-limited, save failure and conflict states. Seed availability SHALL not imply that a person is actively editing. Background conflicts SHALL await the member's existing resolution flow without choosing a side automatically.

#### Scenario: Unresolved offline conflict
- **WHEN** a hidden project's reconnect detects overlapping offline edits
- **THEN** recovery data remains durable, conflicting work is not automatically published, and status offers opening the conflict resolver

### Requirement: Seeding activity isolation
Starting a background-only project SHALL perform synchronization without automatically starting a compiler, participating in compile leadership, pushing GitHub backups, or binding and importing external folders. Those foreground activities SHALL detach when the last editor closes; previously accepted operations SHALL complete or cancel safely without new scheduling.

#### Scenario: Start many seeds
- **WHEN** login startup activates retained projects
- **THEN** no compiler downloads, builds, GitHub pushes or folder imports are triggered solely by seeding

#### Scenario: Return to a bound folder
- **WHEN** a member reopens a workspace whose external folder changed while only its seed was running
- **THEN** the existing safe folder reconciliation runs before folder differences are published

### Requirement: Recoverable desktop data migration
Existing desktop documents, blobs, metadata, history and offline recovery state SHALL migrate without losing content or inventing completeness. Interrupted migration SHALL resume safely, retain its source until verification, and block conflicting writers. An ambiguous legacy account/server association SHALL require resolution before background sharing.

#### Scenario: Crash during migration
- **WHEN** the application stops after copying part of an existing project
- **THEN** restart resumes from verified checkpoints and leaves the original data recoverable

#### Scenario: Legacy offline conflict
- **WHEN** an existing project has an unresolved offline merge at migration time
- **THEN** both versions and the recovery stage remain available after migration and no conflict is auto-resolved

### Requirement: Background relay budget awareness
Background seeding SHALL honor server relay budgets in addition to local resource limits. Text and control traffic SHALL take priority over background assets. Relay-limited projects SHALL show the route, deferred work and retry condition without claiming complete synchronization. Reaching a relay limit SHALL NOT pause unrelated direct transfers.

#### Scenario: Hidden seed reaches a relay limit
- **WHEN** the server defers an asset while the seed has no open editor
- **THEN** the tray and project status show relay-limited synchronization, preserve received content and retry only when permitted or another route becomes available

#### Scenario: Direct route becomes available
- **WHEN** a deferred asset can be fetched over an authenticated direct connection
- **THEN** it resumes under the device's local limits without waiting for the application relay budget to reset

### Requirement: Measured background service usage
Background operation SHALL account for wake-ups, introductions, reconnections and authorization overhead as well as content transfers. A dormant seed SHALL generate no control-plane usage. Budget-driven scheduling SHALL expose queued or unavailable seeds rather than silently dropping them. Presence optimizations SHALL preserve per-session lease ownership and the existing revocation deadlines.

#### Scenario: No edits during a long seed session
- **WHEN** retained projects remain enabled without any collaborator needing them
- **THEN** they stay dormant, usage metrics show no control-plane requests for them, and they still wake when rung

#### Scenario: Seed woken by a collaborator
- **WHEN** a dormant seed is rung and serves a collaborator
- **THEN** usage metrics include that wake-up, introduction and transfer, and the seed returns to dormant after the collaborator leaves

### Requirement: Bounded worker recovery without duplicate processes
A crashed background worker SHALL be reaped before a replacement starts. Repeated crashes SHALL stop automatic restarts after a bounded budget and expose the failure in diagnostics. Closing or reopening a window and concurrent app launches SHALL NOT restart a healthy worker. Application shutdown SHALL terminate its worker and descendants.

#### Scenario: Repeated worker crashes
- **WHEN** the worker repeatedly exits shortly after startup
- **THEN** restarts back off and stop after the crash budget, with no accumulating worker processes

#### Scenario: Update restart
- **WHEN** the desktop restarts after an update
- **THEN** the old process releases its instance resources and the new app runs with exactly one worker
