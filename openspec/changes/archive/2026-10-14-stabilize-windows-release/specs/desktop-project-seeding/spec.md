# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Bounded worker recovery without duplicate processes
A crashed background worker SHALL be reaped before a replacement starts. Repeated crashes SHALL stop automatic restarts after a bounded budget and expose the failure in diagnostics. Closing or reopening a window and concurrent app launches SHALL NOT restart a healthy worker. Application shutdown SHALL terminate its worker and descendants.

#### Scenario: Repeated worker crashes
- **WHEN** the worker repeatedly exits shortly after startup
- **THEN** restarts back off and stop after the crash budget, with no accumulating worker processes

#### Scenario: Update restart
- **WHEN** the desktop restarts after an update
- **THEN** the old process releases its instance resources and the new app runs with exactly one worker
