# Working with Claude Code, Codex, Cursor and other local tools

HiveTeX never sends your sources to an AI service. Instead, a project can **live in a normal folder** on your device
(desktop app, or Chrome/Edge on the web), so any tool that edits files can work on it — and its edits flow to your
collaborators like any other edit. See [Projects in folders](folders.md) for opening a cloned folder as a project,
the `.hivetex.json` marker and per-device locations.

## Use a folder

1. Open the project → toolbar **In the app ▾** → **Use a folder…** → choose (or create) a folder. Or create the project
   **In a folder…**, or open an existing folder (e.g. a `git clone`) with **Open folder…** on the projects page.
2. The project's files are written there immediately. The toolbar shows **📁 <folder>**.
3. Open the folder with your tool:

```bash
cd ~/papers/my-paper
claude          # Claude Code
codex           # OpenAI Codex CLI
cursor .        # Cursor
```

Edits made by the tool are picked up within a fraction of a second (web without `FileSystemObserver`: within 1.5 s), merged into the shared document as *minimal* edits
(your co-authors keep their cursors, concurrent edits survive), and appear on every device. Edits made by collaborators are
written to the folder atomically.

## Review and undo: the Changes view

There are no locks and no "accept" step. Instead, **Changes** in the toolbar lists change sets by source (📁 the
folder, ✎ you, 👤 collaborators), with a diff per file and an **Undo** that reverts one change set for everyone. Use it to
review what an agent did and to roll back what you don't want. History stays on the device for 7 days.

## What is (not) mirrored

Ignored by default: `.git/`, `.claude/`, `.cursor/`, `.agents/`, `.vscode/`, `node_modules/`, LaTeX build files (`*.aux`,
`*.log`, `*.synctex.gz`, `*.bbl`, …), `.DS_Store`. Add your own patterns (gitignore syntax) to a `.hivetexignore` file in the
project root.

You can `git init` inside the folder for local version control — `.git/` is never synchronized.

## Rules of the road

* **Read-only members**: if a viewer's tool changes a file, the change is reverted on disk and a notice is shown; nothing is shared.
* **Deleting or renaming** a file in the folder deletes/renames it in the project for everyone.
* If a tool and a collaborator edit the same file at the same moment, both edits are kept (three-way merge against the last version we wrote).
* On first using a non-empty folder, files in the folder win over differing project files of the same name, and files only
  in the folder are added.
* Edits made while the app was closed are merged when the folder is bound again (see [folders.md](folders.md#edits-made-while-the-app-was-closed)).
* The folder lives on your disk: anyone with access to it can read the sources. Use **Stop using the folder** when you no longer need it (the files stay on disk).

## Using OpenRouter or other model gateways

Anything that works on a folder works here: point your agent or editor extension at the linked folder and configure its
model provider (e.g. an OpenRouter key) in *that* tool. HiveTeX stays out of the loop.

## Verified behavior

`packages/sync/test/mirror.test.ts` plays the role of the external tool against a real directory: edits appear on peers,
remote edits reach the disk in < 1 s, build artifacts and `.hivetexignore` patterns are skipped, a viewer's changes are reverted.
