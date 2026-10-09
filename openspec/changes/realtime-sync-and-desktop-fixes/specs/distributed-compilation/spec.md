# Spec Delta

## MODIFIED Requirements

### Requirement: Engine selection
Projects SHALL let editors choose the TeX engine (pdfLaTeX, XeLaTeX, LuaLaTeX where available) and main file. Devices that do not support the chosen engine SHALL be ineligible for leadership. A device SHALL only advertise engines it can actually run.

#### Scenario: XeLaTeX project
- **WHEN** a project uses XeLaTeX and one peer's engine does not support it
- **THEN** that peer is not elected leader

#### Scenario: Tectonic-only device
- **WHEN** the only TeX engine on a desktop device is Tectonic and it is elected leader of a XeLaTeX project
- **THEN** it compiles the project with Tectonic and every member receives the PDF
