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
