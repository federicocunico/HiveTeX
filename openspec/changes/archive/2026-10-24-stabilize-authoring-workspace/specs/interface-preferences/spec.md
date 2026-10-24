# Spec Delta

## ADDED Requirements

### Requirement: Device-local compilation schedule
Members SHALL choose After changes, Periodic or Manual scheduling on each device. The choice SHALL persist across project changes and app restarts and SHALL NOT be sent to peers. Missing or invalid scheduling preferences SHALL default to After changes. Legacy choices about local versus shared compilation SHALL NOT be interpreted as scheduling preferences.

#### Scenario: First upgrade
- **WHEN** a member upgrades without a scheduling preference
- **THEN** After changes is selected and compilation remains local

#### Scenario: Independent collaborators
- **WHEN** one member chooses Manual and another chooses Periodic
- **THEN** each device follows its own choice while their sources continue synchronizing

#### Scenario: Reopen in Manual
- **WHEN** a member restarts with Manual selected
- **THEN** opening a project does not automatically start a build and Compile now remains available

### Requirement: Validated periodic interval
Periodic scheduling SHALL accept whole-second intervals from 5 to 300 seconds and default to 30 seconds. Invalid persisted values SHALL fall back to 30 seconds. Invalid user input SHALL identify the allowed range without replacing the previous valid interval. Account preferences, the compile menu and command-palette access SHALL refer to the same device preference.

#### Scenario: Invalid interval entry
- **WHEN** a member enters zero, a negative value, nonnumeric text or a value above 300 seconds
- **THEN** the interface explains the allowed range and the previous valid interval remains active

#### Scenario: Corrupt saved interval
- **WHEN** persisted preferences contain an invalid interval
- **THEN** the app starts with a 30-second periodic interval and otherwise valid preferences remain usable

#### Scenario: Preference changed in another tab
- **WHEN** another workspace tab on the same device changes the scheduling preference
- **THEN** open workspaces reflect the new preference and discard automatic requests that no longer apply
