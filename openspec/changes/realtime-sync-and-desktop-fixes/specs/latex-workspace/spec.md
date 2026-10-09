# Spec Delta

## MODIFIED Requirements

### Requirement: Two delivery modes with one feature set
The workspace SHALL be available as a web app served from the public deployment and as an installable desktop app for Windows, macOS and Linux. Both SHALL interoperate in the same project. The desktop app SHALL use the hosted control plane over the network, and the control plane SHALL accept those cross-origin requests from the desktop app only.

#### Scenario: Mixed clients
- **WHEN** one member uses the web app and another uses the desktop app on the same project
- **THEN** they edit together and see the same compiled PDF

#### Scenario: Desktop signs in to the hosted control plane
- **WHEN** a user signs in from the desktop app pointed at the public deployment
- **THEN** sign-in, project list, tickets and relay credentials work as in the web app

#### Scenario: Other websites
- **WHEN** a page on another website calls the control plane API from a visitor's browser
- **THEN** the browser blocks the response because that origin is not allowed
