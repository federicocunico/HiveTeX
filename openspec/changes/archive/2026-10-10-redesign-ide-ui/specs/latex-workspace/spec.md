# Spec Delta

## MODIFIED Requirements

### Requirement: Accessible and responsive UI
The workspace SHALL be keyboard-navigable and remain usable on screens down to 1024 px wide; project list and
settings SHALL also work on phone-sized screens. In addition:
- text and controls SHALL meet WCAG 2.2 AA contrast in both themes;
- every interactive element SHALL show a visible focus indicator;
- every dialog SHALL move focus into itself on open, keep focus inside while open, close with Escape, and return focus
  to the control that opened it.

#### Scenario: Keyboard only
- **WHEN** a user navigates the file tree, editor and preview using only the keyboard
- **THEN** all primary actions are reachable

#### Scenario: Contrast in both themes
- **WHEN** the automated accessibility check runs on the landing, sign-in, registration, projects and workspace
  screens in the light theme and again in the dark theme
- **THEN** it reports no serious or critical violations, including color-contrast

#### Scenario: Dialog focus
- **WHEN** a keyboard user opens the Share dialog, presses Tab repeatedly and then Escape
- **THEN** focus cycles only within the dialog, and after Escape it returns to the Share button

#### Scenario: Narrow window
- **WHEN** the workspace is shown at 1024 px wide with a long user name and project name
- **THEN** nothing overflows horizontally and the header actions remain reachable
