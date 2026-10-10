# Spec Delta

## Purpose

Lets each person adapt the interface to their eyes and habits on each device: theme, editor text size, toolbar
visibility and the workspace layout. These choices are personal and never affect co-authors.

## ADDED Requirements

### Requirement: Theme choice
Users SHALL be able to choose Light, Dark or System. System SHALL follow the operating system's setting and change
when it changes. The choice SHALL apply to the whole app, including the editor. It SHALL NOT apply to the rendered PDF
pages, which keep the document's own colors.

#### Scenario: Pick dark
- **WHEN** a user selects Dark in preferences
- **THEN** the app and editor switch to the dark theme immediately, and the PDF pages stay as compiled

#### Scenario: Follow the system
- **WHEN** the theme is System and the operating system switches from light to dark
- **THEN** the app switches to dark without a reload

### Requirement: No flash of the wrong theme
The chosen theme SHALL be applied before the first paint, so starting the app or reloading never shows the other
theme first.

#### Scenario: Reload in dark
- **WHEN** a user with Dark selected reloads the web app
- **THEN** no light frame is shown during loading

### Requirement: Editor text size
Users SHALL be able to set the editor font size between 11 and 24 px, and the editor line height SHALL scale with it.
The interface text size SHALL follow the browser or system zoom.

#### Scenario: Larger editor text
- **WHEN** a user sets the editor font size to 18 px
- **THEN** source text in every open editor uses 18 px, and other users are unaffected

### Requirement: Formatting toolbar visibility
Users SHALL be able to hide or show the formatting toolbar. The toolbar's actions SHALL stay available from the
command palette and shortcuts while it is hidden.

#### Scenario: Hide the toolbar
- **WHEN** an experienced user hides the formatting toolbar
- **THEN** it stays hidden in every project on that device, and "Insert figure" is still in the command palette

### Requirement: Remembered layout
Panel and pane sizes, the open side panel, PDF visibility and the zoom level SHALL be remembered on the device and
restored the next time the user opens a project. Users SHALL be able to reset the layout to its defaults.

#### Scenario: Restore layout
- **WHEN** a user widens the PDF pane, closes the project and opens another one
- **THEN** the PDF pane has the width they set

#### Scenario: Reset layout
- **WHEN** a user chooses "Reset layout" from the command palette
- **THEN** pane sizes, panel and PDF visibility return to their defaults

### Requirement: Preferences are per device and private
Interface preferences SHALL be stored only on the device, SHALL survive app updates, and SHALL NOT be sent to the
server or to peers. Preferences SHALL be reachable from Account and from the command palette.

#### Scenario: Two devices
- **WHEN** a user picks Dark on their laptop
- **THEN** their desktop computer keeps its own theme, and no network request carries the choice

### Requirement: Reduced motion
When the operating system asks for reduced motion, the app SHALL turn off non-essential animation, including panel
slide-ins, the landing page demo and smooth scrolling for jumps. The resulting state SHALL be shown at once.

#### Scenario: Reduced motion on
- **WHEN** reduced motion is set in the operating system and the user opens the Outline panel
- **THEN** the panel appears without a slide animation
