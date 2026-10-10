# Spec Delta

## Purpose

Makes every action in the app reachable by name and by keyboard: a command palette, global shortcuts, a shortcut
reference and optional editor keymaps for experienced users.

## ADDED Requirements

### Requirement: Command palette
The app SHALL open a command palette with Ctrl+K (Cmd+K on macOS) from any signed-in screen. The palette SHALL
search, with fuzzy matching:
- actions available on the current screen;
- project files;
- outline headings;
- projects.

Each action SHALL show its shortcut if it has one. Actions the user's role does not allow SHALL NOT be listed.

#### Scenario: Run an action
- **WHEN** a user in a project opens the palette, types "comp" and presses Enter on "Compile now"
- **THEN** the palette closes and a compile starts exactly as with the Recompile button

#### Scenario: Open a file
- **WHEN** a user types part of a file name and selects the file
- **THEN** the file opens in the editor

#### Scenario: Viewer palette
- **WHEN** a viewer searches for "rename"
- **THEN** no rename or delete action is offered

### Requirement: Palette prefixes
The palette SHALL support these prefixes:
- `>` limits results to actions;
- `@` limits results to outline headings of the open file;
- `:` followed by a number jumps to that line.

#### Scenario: Go to line
- **WHEN** a user types `:120` and presses Enter
- **THEN** the editor moves the cursor to line 120 of the open file

### Requirement: One registry for actions
Each workspace action SHALL be defined once, with its name, shortcut, role requirement and handler. The palette, the
shortcut handler, menus and the shortcut reference SHALL all use that one definition, so a label or shortcut can never
differ between them.

#### Scenario: Shortcut shown matches shortcut used
- **WHEN** the palette lists "Toggle PDF" with Ctrl+Alt+P
- **THEN** pressing Ctrl+Alt+P in the workspace shows or hides the PDF pane

### Requirement: Compile shortcuts
The workspace SHALL compile with Ctrl/Cmd+Enter, and with Ctrl/Cmd+S as an alias because saving is automatic. It SHALL
compile on this device with Ctrl/Cmd+Shift+Enter.

#### Scenario: Compile from the keyboard
- **WHEN** a user with the cursor in the editor presses Ctrl+Enter
- **THEN** a compile starts and no newline is inserted

#### Scenario: Save habit
- **WHEN** a user presses Ctrl+S in the workspace
- **THEN** the browser's save-page dialog does not open and a compile starts

### Requirement: Layout and navigation shortcuts
The workspace SHALL provide these shortcuts:
- toggle side panel: Ctrl/Cmd+Shift+E;
- toggle PDF: Ctrl/Cmd+Alt+P;
- focus mode: Ctrl/Cmd+Shift+F;
- project search: Ctrl/Cmd+Shift+H;
- shortcut reference: Ctrl/Cmd+Shift+/ (Ctrl+?), because Ctrl/Cmd+/ toggles a comment in the editor;
- forward SyncTeX jump: Ctrl/Cmd+Alt+J, as today.

#### Scenario: Toggle the side panel
- **WHEN** a user presses Ctrl+Shift+E with the Files panel open
- **THEN** the side panel collapses, and pressing it again reopens Files

### Requirement: Shortcuts do not take over editing keys
App shortcuts SHALL NOT override the editor's text-editing keys, including Ctrl/Cmd+B and Ctrl/Cmd+I for bold and
italic, or keys the browser or operating system reserves.

#### Scenario: Bold still bolds
- **WHEN** an editor selects a word in a `.tex` file and presses Ctrl+B
- **THEN** the word is made bold and no panel opens or closes

### Requirement: Shortcut reference
The app SHALL show a reference of all shortcuts, grouped by area, from Help, from the palette and with Ctrl/Cmd+Shift+/.

#### Scenario: Open the reference
- **WHEN** a user presses Ctrl+Shift+/ in the workspace
- **THEN** a dialog lists every shortcut with its action, and Escape closes it

### Requirement: Optional editor keymaps
Users SHALL be able to choose a Default, Vim or Emacs keymap for the editor. The choice is stored per device. Vim and
Emacs support SHALL be loaded only when chosen.

#### Scenario: Turn on Vim
- **WHEN** a user selects the Vim keymap in preferences and returns to the editor
- **THEN** the editor starts in normal mode and shows the current Vim mode in the status bar

#### Scenario: Default keymap costs nothing
- **WHEN** a user keeps the default keymap
- **THEN** no Vim or Emacs code is downloaded
