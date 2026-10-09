# Working with Claude Code, Codex, Cursor and other local tools

p2platex never sends your sources to an AI service. Instead, the **desktop app mirrors a project into a normal folder**, so any
tool that edits files can work on it — and its edits flow to your collaborators like any other edit.

## Link a folder

1. Open the project in the desktop app → **Link folder…** → choose (or create) an empty folder.
2. The project's files are written there immediately. The status bar shows *folder linked*.
3. Open the folder with your tool:

```bash
cd ~/papers/my-paper
claude          # Claude Code
codex           # OpenAI Codex CLI
cursor .        # Cursor
```

Edits made by the tool are picked up within a fraction of a second, merged into the shared document as *minimal* edits
(your co-authors keep their cursors, concurrent edits survive), and appear on every device. Edits made by collaborators are
written to the folder atomically.

## What is (not) mirrored

Ignored by default: `.git/`, `.claude/`, `.cursor/`, `.agents/`, `.vscode/`, `node_modules/`, LaTeX build files (`*.aux`,
`*.log`, `*.synctex.gz`, `*.bbl`, …), `.DS_Store`. Add your own patterns (gitignore syntax) to a `.p2platexignore` file in the
project root.

You can `git init` inside the folder for local version control — `.git/` is never synchronized.

## Rules of the road

* **Read-only members**: if a viewer's tool changes a file, the change is reverted on disk and a notice is shown; nothing is shared.
* **Deleting or renaming** a file in the folder deletes/renames it in the project for everyone.
* If a tool and a collaborator edit the same file at the same moment, both edits are kept (three-way merge against the last version we wrote).
* On first linking a non-empty folder, files in the folder win over differing project files of the same name, and files only
  in the folder are added.
* The folder lives on your disk: anyone with access to it can read the sources. Remove the link (**Unlink folder**) when you no longer need it.

## Using OpenRouter or other model gateways

Anything that works on a folder works here: point your agent or editor extension at the linked folder and configure its
model provider (e.g. an OpenRouter key) in *that* tool. p2platex stays out of the loop.

## Verified behavior

`packages/sync/test/mirror.test.ts` plays the role of the external tool against a real directory: edits appear on peers,
remote edits reach the disk in < 1 s, build artifacts and `.p2platexignore` patterns are skipped, a viewer's changes are reverted.
