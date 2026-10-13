# product-identity Specification

## Purpose
Keeps the product consistently presented as HiveTeX, the only name used anywhere in the product, its code and its
documentation.

## Requirements

### Requirement: One product name
Everything a user sees SHALL use the name HiveTeX, including:
- the application and window title;
- installer and application bundle names;
- release names and emails;
- the web interface and documentation;
- command-line output.

#### Scenario: Installer names
- **WHEN** a release is built
- **THEN** the Windows installer is named `HiveTeX_<version>_x64-setup.exe`, and the installed application shows
  "HiveTeX" in its window title and in the system's app list

#### Scenario: Emails
- **WHEN** a user registers
- **THEN** the verification email is sent from and signed as HiveTeX

### Requirement: Identifiers use the product name
Every name the app stores or writes SHALL use `hivetex`: storage keys and databases, the OS keychain service and the
application identifier, folder files (`.hivetex.json`, `.hivetexignore`), the GitHub backup trailer and branch, and
build and CI variables. The app SHALL NOT read or write any other product name.

#### Scenario: A bound folder
- **WHEN** a project is bound to a folder
- **THEN** the folder's marker is `.hivetex.json` and its ignore file, if any, is `.hivetexignore`

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
