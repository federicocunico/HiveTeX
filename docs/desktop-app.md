# The desktop app in the background

Closing the HiveTeX window does not stop synchronization. The app keeps running in the system tray, so co-authors can
still get your projects and your device keeps receiving their changes. Quit is the only way to stop it.

## Tray

| Action | What it does |
| --- | --- |
| Click the icon / **Open HiveTeX** | Opens the window again (it is recreated if it was closed). |
| Status line (first, greyed item; also the icon's tooltip) | A summary of the projects kept in the background, for example "3 projects: 2 reachable on request, 1 receiving", or "Synchronization paused". |
| **Pause all synchronization** / **Resume synchronization** | The same as *Work offline for all projects* on the projects page. No server requests, sockets or port mapping while paused. Edits are kept. |
| **Quit HiveTeX** | Saves every project, removes the router port mapping and exits. If something cannot be saved, the window opens instead and lists the projects. You can then open each one and use *Export recovery copy*, or choose *Quit and discard unsaved edits*. |

Launching HiveTeX again while it runs opens the existing window. It never starts a second copy (one connection per
project and device). A browser asking to compile on this computer (pairing) also brings the window back to ask you.

**No tray.** Some Linux desktops have no tray area (GNOME without the AppIndicator extension, for example). The app
then never hides itself: closing the window minimizes it, synchronization continues, and a notice at the bottom of
the window offers *Pause all synchronization* and *Quit HiveTeX*.

## Starting with the computer

Under **Your projects → Background syncing**:

- **Start HiveTeX when I sign in to this computer**: off until you select it. It registers HiveTeX with the system
  (Windows: the per-user *Run* key; macOS: a Launch Agent; Linux: an autostart entry). Clearing it removes the
  registration.
- **Start in the background (no window)**: for those login starts only. The tray appears and retained projects sync
  without opening the editor. Starting HiveTeX yourself always opens the window.

If the system keychain is locked at login, projects show *Sign in to resume*. HiveTeX does not create a temporary
identity and does not retry in a loop.

## The other settings on that page

- **Enable background syncing**, and *Seed* per project: which projects are kept available. See the README.
- **Work offline for all projects**: the same as the tray's Pause.
- **Ask the router to forward a port (UPnP)**: see [router port mapping](port-mapping.md). The line below it shows the
  mapping state, never a connection state.
- **Quit HiveTeX**: the same as the tray's Quit.

All of these are ordinary labelled checkboxes and buttons, reachable with Tab and operated with Space/Enter. The
tray menu uses the system's native menu and its keyboard support.

## Updates

After an update is installed, HiveTeX quits the same way as **Quit** and starts the new version: still one app, one
worker and one connection per project.

## Platform notes

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Tray icon | notification area | menu bar | needs a StatusNotifier/AppIndicator host; otherwise the no-tray behaviour above |
| Launch at login | per-user Run key | Launch Agent | `~/.config/autostart` entry |
| Second launch | focuses the running app | same | same (D-Bus) |

## Evidence

- `apps/desktop/e2e/lifecycle.mjs` (run by `run.mjs`, Windows) checks the following without WebDriver:
  - closing keeps the app and its worker running;
  - a second launch reopens the same process;
  - a pairing request shows the window;
  - restarting after an update leaves one app and one worker;
  - a background login start opens no window, while a manual launch does.
- `desktop.test.mjs` › *launch at login is opt-in and removable; Quit flushes, stops the worker and exits*.
- `cargo test --lib -- lifecycle::`: background-launch rule, tray status text.
- `packages/sync` `seed-catalog.test.ts` › *quit reports projects that cannot save; a closed window detaches only
  editor attachments*.
- `apps/web` `seed-label.test.ts` and `desktop-a11y.test.ts`: status texts and keyboard-reachable labelled controls.
