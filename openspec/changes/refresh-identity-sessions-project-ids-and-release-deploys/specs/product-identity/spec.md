# Spec Delta

## ADDED Requirements

### Requirement: Recognizable application mark
HiveTeX SHALL use a distinctive connected honeycomb H mark that represents collaborative writing. The mark SHALL be legible at 16, 24, 32 and 128 pixels, with a simplified small-size rendition, and SHALL contrast with both light and dark surroundings. The icon SHALL remain recognizable without the HiveTeX wordmark.

#### Scenario: Browser tab and desktop launcher
- **WHEN** a user sees HiveTeX in a browser tab and in the operating system launcher
- **THEN** both show the same recognizable mark, legible at their displayed sizes

#### Scenario: Light and dark presentation
- **WHEN** the interface switches between light and dark themes
- **THEN** the mark remains visible and uses the same shape and identity

### Requirement: Consistent icon distribution
The web header, public and account screens, favicon, desktop application, taskbar or dock, and installers SHALL use renditions of the same approved vector mark. The application icon SHALL use amber and warm ivory on a graphite tile. Accessible links containing only the mark SHALL identify HiveTeX.

#### Scenario: Packaged desktop release
- **WHEN** installers are built for Windows, macOS and Linux
- **THEN** every package embeds the new mark in the platform's required icon formats

#### Scenario: Icon-only navigation
- **WHEN** a screen reader reaches an icon-only home link
- **THEN** its accessible name identifies HiveTeX and its navigation purpose
