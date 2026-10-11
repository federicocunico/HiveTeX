## ADDED Requirements

### Requirement: Installing a new version replaces the old one
Running a HiveTeX Windows installer SHALL remove any previous HiveTeX installation on the machine, whichever installer
type (setup executable or MSI) created it, before installing the new version, so that exactly one HiveTeX remains
installed and listed in Apps. The user's projects, settings and stored credentials SHALL be kept. The replacement SHALL
not require the user to uninstall manually.

#### Scenario: Upgrade over the same installer type
- **WHEN** version 0.2.1 was installed with the setup executable and the user runs the 0.3.0 setup
- **THEN** only 0.3.0 is installed afterwards and its files replace the old ones

#### Scenario: Upgrade across installer types
- **WHEN** version 0.2.1 was installed from the MSI and the user runs the 0.3.0 setup executable
- **THEN** the MSI installation is removed and only 0.3.0 is listed in Apps

#### Scenario: User data survives
- **WHEN** an upgrade replaces the old installation
- **THEN** local projects, preferences, the chosen server and the signed-in session are still present
