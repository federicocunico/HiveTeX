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

## ADDED Requirements

### Requirement: Mirror imports only complete file writes
The desktop folder mirror SHALL import a file change from disk only once the file content is stable, so a file caught in the middle of being rewritten (for example truncated before new content is written) is never merged into the project.

#### Scenario: Tool rewrites a file while a co-author types
- **WHEN** an external program rewrites `main.tex` in the bound folder (truncating it first) while a co-author appends a line remotely
- **THEN** every device ends with the program's change and the co-author's line in their correct places, with no content lost or reordered
