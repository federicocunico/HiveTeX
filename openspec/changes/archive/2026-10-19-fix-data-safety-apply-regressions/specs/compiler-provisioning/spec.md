# Spec Delta

## ADDED Requirements

### Requirement: Compiler status follows the active engine
The compiler status in the workspace SHALL change whenever the engine used for builds changes, including after pairing
the desktop helper. It SHALL NOT keep offering setup while builds succeed.

#### Scenario: Pairing the desktop helper
- **WHEN** a web member pairs the desktop helper and the next build uses it
- **THEN** the status bar names the helper without a reload, and does not show "Set up a local compiler"
