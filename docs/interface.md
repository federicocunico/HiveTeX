# The interface

HiveTeX looks the same in the browser and in the desktop app. This page is a tour of the screens and a reference of
the keyboard shortcuts.

![The workspace: files on the left, source in the middle, the PDF on the right](images/workspace-light.png)

## Projects

*Your projects* lists every project you own or joined, most recently opened first. Filter by name, switch between
*All*, *Owned by me* and *Shared with me*, or sort by name. Each row shows your role and whether the project is
password protected, kept in a folder on this device, or backed up to GitHub.

- **New project** opens the template gallery: Blank, Article, Thesis or report, Beamer slides, Letter and CV. Every
  template compiles as it is and explains its parts in comments. You can also start from an Overleaf `.zip`, an arXiv
  tarball or a folder.
- **Join with ID** asks for the project ID and password a co-author sent you.
- **Open folder…** opens a disk folder, for example a `git clone`: live sync on desktop, a read-only import preview in Chrome and Edge.

## The workspace

**Changes** shows file operations by original author and device, with verified peer origin distinguished from unknown
legacy attribution. Hover the origin icon to see whether the operation came from an editor, folder, import, undo or
version restore. History transfer has its own progress; “sources synced” does not mean all historic evidence arrived.
Undo checks the current contents and paths. It preserves later work and reports files it cannot safely invert;
clicking twice does not apply the same inverse twice. Even an entirely refused undo has an explicit result.

**History** keeps local snapshots including the main file, engine/settings and exact available assets. Preview restore
validates a target; confirmation creates a recovery point before changing the project. A new remote edit or lost write
permission invalidates the decision; a refused restore leaves nothing pending and can be previewed again at once. If an
undo or restore was interrupted (crash, quit, lost storage), History shows "… was interrupted" at the top with two
actions. **Complete** finishes it: an undo inverts only the files it had not inverted yet, a restore applies the
prepared target. **Cancel** puts back what it had changed, from the recovery snapshot saved before it started, and
keeps later edits. Neither runs automatically. The oldest displayed Change is not a promise that older bytes
were purged: snapshots, tombstones, binary versions and operation evidence remain retained.

History → **Recovery** lists deleted files, structural conflicts, older orphan documents and private folder copies.
Download works for viewers; modifying the shared project requires current edit permission. Choose Restore, Keep both
or Keep deleted while retaining recovery. **More → Export full recovery copy** includes readable files and a hashed
private storage archive, including any unreadable-entry report. Keep that export private.

| Area | What it does |
|---|---|
| Header | Back to your projects, the project ID and your role, who is online, **Share**, **Recompile** (every build runs on this device), **Download PDF**, and **More actions** (import, download the project, history, focus mode, the tour, settings). *Download project (.zip)* waits for files that are still arriving; if some cannot be obtained it lists them and downloads nothing, rather than an archive with empty files. |
| Rail | Switches the side panel: **Files**, **Outline**, **Search**, **Changes** (with a count of co-authors' changes you have not seen), **History**, **People**, **Sync** and **GitHub backup**. Click the open panel's icon again to hide it. The gear opens project settings. |
| Editor | The LaTeX source. Above it, the formatting toolbar inserts headings, bold and italic, lists, inline math and equations, symbols, figures, tables, citations and cross-references, and each button's tooltip shows the LaTeX it writes. Below it, **Problems** lists compile errors and warnings; common ones come with a plain-language explanation and, for a missing package, an *Add package* button. |
| PDF | The compiled document with zoom and page navigation. *Up to date* or *Outdated: N edits since the last compile* says whether it shows your latest edits; *compiled by* names the device that built it. Double-click the PDF to jump to the source line; Ctrl+Alt+J jumps from the source to the PDF. |
| Status bar | Whether your changes are synced (with the time of the last sync, or a percentage while files are still arriving), or kept offline; how many co-authors are online (and how many are still connecting); the local compiler state and the cursor position. |

Right-click a file or the **Files** panel (or press Shift+F10 on a focused file) for its actions: open, rename or
move, delete, set as main document, download and, in the desktop app, **Open folder**, **Open in terminal** (for Claude
Code, Codex and other tools), **Copy folder path** and **Show in file manager**. See
[Projects in folders](folders.md#right-click-in-the-files-panel-open-the-folder-or-a-terminal).

Drag the dividers (or focus one and use the arrow keys) to resize the side panel and the editor/PDF split. Hide the
PDF with its panel button or Ctrl+Alt+P. **Focus mode** (Ctrl+Shift+F) hides everything except the editor and PDF.
Panel sizes, the open panel, PDF visibility and zoom are remembered on this device; *Reset layout* restores the
defaults. Below 1100 px wide the workspace shows the editor or the PDF, with a toggle in the header.

The first time you open a project, a four-step tour points out the editor, the rail, compiling and sharing. Skip it
at any step; *Take the tour* in **More actions** shows it again.

### Writing together

- Each person has one color, everywhere: their avatar, cursor, selection and the dots on the files they have open.
- Hover an avatar to see which file that person is in. Click it to **follow** them: your editor opens their file and
  keeps their cursor in view. Typing, scrolling or picking another file stops following.
- **Share** shows the project ID with **Copy invitation**, a short text with the ID and how to join (never the
  password; send that separately). Owners also set the password, the role new members get, and each member's role.

### Sync

Joining a project can take a while: the app first finds your co-authors, then receives the file list, then the contents.
The status bar and the **Sync** panel say where you are, in words:

- **Connecting to a co-author...**: someone is online but the connection is still being set up. They are listed as
  *connecting* in **People**. The app keeps retrying on its own.
- **Syncing 40%: 4 of 10 files**: the file list has arrived; files not yet received are shown dimmed in the file tree
  and listed first in the Sync panel.
- **All changes synced** with a time: every file is on this device. This is never shown while files are missing.

The Sync panel lists every file with its state and shows who is editing it right now, in their color. **Sync now**
retries the connection to co-authors who are online, asks every co-author again for every file and downloads what is
missing; it tells you what it did. A notification appears when everything has arrived, or when nothing has progressed
for a minute while files are still missing.

While files are missing on this device, **compiling, downloading the project (.zip) and GitHub backup** wait for them or
are refused, and the message names the files that have not arrived. They never use an empty stand-in. Once everything
has arrived, they work again, offline too. See [What is here, what is saved, what is current](offline.md#what-is-here-what-is-saved-what-is-current).

**Known limit:** opening the same project in several tabs of the same browser profile is not supported. The tabs share
one device identity and do not coordinate, so use one tab per project.

### Offline work and conflicts

Edits made while no co-author is connected are merged like git when one connects: changes in different places merge
on their own (a message lists the files), and changes to the same lines become **conflicts**. A red *N conflicts to
resolve* in the status bar, or the bar above the file, opens **Resolve conflicts**: keep mine, keep theirs, keep both,
or edit, then **Apply and share**. While conflicts are pending, *Unshared changes* in the status bar shows that this
device holds work the others have not seen yet. See [Working offline](offline.md).

### Without an account (desktop)

**Continue without an account** on the sign-in screen opens *local mode*: projects stay on this computer (*On this
computer*), nothing is sent anywhere, and the header shows *Local* and **Sign in to share**. After signing in, each
local project offers **Share…** and **Merge into a project…** ([details](offline.md#without-an-account-desktop)).

## Command palette

**Ctrl+K** (Cmd+K on a Mac) opens the command palette anywhere after signing in. Type a few letters of what you want:
an action, a file, a heading or a project. The best match runs with Enter.

| Type | To |
|---|---|
| `>` | search actions only |
| `@` | jump to a heading in the open file |
| `:120` | go to line 120 |
| `?` | open the shortcut reference |

## Preferences

*Account and preferences* holds the settings of this device: theme (system, light or dark), editor text size, the
formatting toolbar, and Vim or Emacs keys for the editor. They are never sent to the server or to co-authors.

## Keyboard shortcuts

Mod means Ctrl on Windows and Linux, Cmd on a Mac. The same list is in the app: Ctrl+Shift+/ or *Keyboard shortcuts*
in the palette. Shortcuts never take over the editor's own keys.

<!-- shortcuts:start (generated from the command registry by e2e/docs.spec.ts; run it with UPDATE_DOCS=1 to refresh) -->
| Action | Keys |
|---|---|
| Bold | Mod+B (in the editor) |
| Command palette | Mod+K |
| Compile now | Mod+Enter, Mod+S or Mod+Shift+Enter |
| Focus mode | Mod+Shift+F |
| Italic | Mod+I (in the editor) |
| Keyboard shortcuts | Mod+Shift+/ |
| Search in project | Mod+Shift+H |
| Show or hide the PDF | Mod+Alt+P |
| Show or hide the side panel | Mod+Shift+E |
| Show this line in the PDF | Mod+Alt+J (in the editor) |
<!-- shortcuts:end -->

Editor keys:

| Action | Keys |
|---|---|
| Toggle comment | Mod+/ |
| Find in file | Mod+F |
| Select next occurrence | Mod+D |
| Undo / redo | Mod+Z / Mod+Shift+Z |
| Show completions | Ctrl+Space |
| File actions (in the Files panel) | Shift+F10 or the context-menu key |
