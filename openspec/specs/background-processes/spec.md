# background-processes Specification

## Purpose
Keeps the helper programs the desktop app runs on the user's behalf invisible, so opening, editing, saving and
compiling a project never flashes a window or takes focus away from the editor.

## Requirements

### Requirement: Background programs run without a visible window
Every program the desktop app starts on its own, without the user asking to see it, SHALL run without showing a
window, console or taskbar entry. This covers TeX detection, compilation, package lookup and installation, and
unpacking downloaded compilers. It SHALL hold on Windows, macOS and Linux, and for any program those programs start
in turn.

#### Scenario: Opening a project
- **WHEN** the user opens a project in the desktop app on Windows and the app checks which TeX is installed
- **THEN** no console or other window appears, even briefly

#### Scenario: Saving triggers a compile
- **WHEN** the user presses Ctrl+S and a local compile runs
- **THEN** no window appears during the build, and the editor keeps keyboard focus

#### Scenario: First compile of the session
- **WHEN** the first compile after starting the app checks which TeX folders a build may read
- **THEN** no window appears

#### Scenario: Missing package installed on demand
- **WHEN** a build with the managed full LaTeX needs a package and the app installs it
- **THEN** no console appears while the package is found and installed; progress is shown only inside the app

#### Scenario: Installing full LaTeX
- **WHEN** the user installs the managed full LaTeX on Windows
- **THEN** the download is unpacked with no extractor window; progress is shown only inside the app

### Requirement: Background programs do not take focus
Background programs SHALL NOT take keyboard focus or come to the foreground. Typing in the editor while they run
SHALL go to the editor.

#### Scenario: Typing during a build
- **WHEN** the user keeps typing while a compile triggered by a save is running
- **THEN** every keystroke lands in the editor

### Requirement: Programs the user asks for stay visible
Programs the user explicitly asks to open SHALL still open in a visible window. **Open in terminal** opens the
system terminal in the project folder, and opening a folder or file shows it in the system's file manager or viewer.

#### Scenario: Open in terminal
- **WHEN** the user chooses Open in terminal on Windows
- **THEN** a terminal window opens in the project folder and stays open

### Requirement: Saving does not repeat TeX detection
A compile SHALL NOT re-run TeX detection programs when the installed compilers have not changed since the last
detection in the same session. Detection SHALL run again after a managed compiler is installed or removed, and when
the compiler panel asks for the current state.

#### Scenario: Repeated saves
- **WHEN** the user saves ten times in a row and each save compiles
- **THEN** the TeX version check runs at most once across those compiles

#### Scenario: Compiler installed during the session
- **WHEN** the user installs the managed full LaTeX and then compiles
- **THEN** the compile uses the newly installed compiler
