# Proposal

## Why

While implementing `harden-realtime-peer-sync` (released in v0.4.0), the agents made two choices in places where the
specs said nothing, or where they contradicted another rule. Both are in the code and covered by tests, but not in the
specs. Two known limits are also only in design notes, not in user docs. This change records the shipped behavior,
so the specs match the product and users know what to expect.

## What Changes

- **Offline work when the only linked co-author is a viewer** (group 6). A viewer cannot confirm shared state, so no
  three-way merge is possible. The offline work of a member who can edit is shared as it is, at once, and an editor
  who links later merges against it. This is now a spec requirement. It is already documented in `docs/offline.md`.
  - Accepted risk: if an editor who is not linked changed the same file meanwhile, the conflict appears later, when
    that editor links, instead of in a merge right away.
  - Rejected alternative: keep the work pending until an editor links. Safer, but the work stays unshared indefinitely.
- **Viewer binds a folder with files that are not in the project** (group 7). At bind time and on reopening, such files
  stay on disk with a notice. A file that exists in both places but differs is restored from the project, also with a
  notice. This changes the wording of *Viewer-safe initial folder binding*, which until now said bind-time differences
  follow the same policy as later edits, and that policy deletes extra files.
  - Why: the project's file list may not be complete yet at bind time. Deleting could empty the folder by mistake.
  - Rejected alternative: delete extra files only once the file list is confirmed complete.
  - Later external changes by a viewer keep the existing policy: they are reverted, and new files are removed.
- **User docs for two known limits.**
  - Compiling, exporting and backing up are refused while the file list is not complete on the device, and the
    missing files are named. This is intended. The user-facing docs now say it plainly in one place.
  - Opening the same project in several tabs of the same browser profile is not supported. Until now this was only
    noted in the archived design. The docs now carry a note for users.

No code changes.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `peer-sync`: new requirement for sharing offline work when the only linked co-author is a viewer.
- `latex-workspace`: *Viewer-safe initial folder binding* now says what happens to files not in the project and to
  files that differ at bind time.

## Impact

- Specs: `openspec/specs/peer-sync`, `openspec/specs/latex-workspace`.
- Docs: `docs/offline.md`, `docs/interface.md`, `docs/folders.md`.
- Code: none. The behavior is already in `packages/sync/src/fork.ts` and `packages/sync/src/mirror.ts`, and covered by
  `packages/sync/test/fork-confirm.test.ts` and `packages/sync/test/mirror-baseline.test.ts`.
