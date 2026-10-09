# Spec Delta

## MODIFIED Requirements

### Requirement: Engine selection
Projects SHALL let editors choose the TeX engine (pdfLaTeX, XeLaTeX, LuaLaTeX where available) and main file. Devices that do not support the chosen engine SHALL be ineligible for leadership. A device SHALL only advertise engines it can actually run with the compile isolation guarantees.

#### Scenario: XeLaTeX project
- **WHEN** a project uses XeLaTeX and one peer's engine does not support it
- **THEN** that peer is not elected leader

#### Scenario: Tectonic-only device
- **WHEN** the only TeX engine on a desktop device is Tectonic
- **THEN** the device advertises no engine, is never elected leader, and its user is told to install TeX Live, MiKTeX or MacTeX to compile on that device
