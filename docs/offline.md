# Working offline, and without an account

## Without an account (desktop)

On the desktop sign-in screen, **Continue without an account** opens HiveTeX in *local mode*:

- **Projects live only on this computer**, listed under *On this computer*. Templates, imports, compiling, history,
  folders and the Files right-click menu (Open folder, Open in terminal…) all work.
- **Nothing is sent anywhere:** the app makes no request to any HiveTeX server and opens no connection. The quick
  compiler may still download LaTeX packages it needs (package names only, never your files).
- **The app remembers it:** it opens in local mode next time, without asking to sign in.

**Sign in to share** (in the header) keeps your local projects. Each one then offers:

- **Share…:** it becomes a shared project with a project ID and password, holding exactly its files and history. A
  linked folder stays linked.
- **Merge into a project…:** join an existing project (ID and password), and the local files are merged into it.
  - Files only in one of the two are kept.
  - A file at the same path with different content becomes a conflict to resolve (see below).
  - The local project is removed once merged.

## Work done without the others

Edits made while no co-author's device is connected are kept on your device first. This covers no network, *Work
offline*, or simply nobody else online. When a co-author connects, each file is merged the way git merges: three-way,
by lines, against the last version you both had.

| What happened while apart | Result |
|---|---|
| Only you changed the file (or only they did) | That version is taken, silently. |
| You both changed it, in different places | Both changes are kept. A message lists the files merged this way. |
| You both changed the same lines | A **conflict**: you decide (see below). Until then, co-authors keep seeing their version and yours stays on your device. |
| You added a file | It is added for everyone. |
| You deleted a file they did not change (or the reverse) | It is deleted. |
| You deleted a file they changed (or the reverse) | A conflict: keep it or delete it. |
| You both renamed the same file differently | A conflict: choose one name. |
| You both replaced the same image | A conflict: choose one version. |

While you are connected, editing stays live and character by character: nothing here applies to typing together.

**Details:**

- **One device merges.** When both devices worked apart, one of them shares its work as it is, and the other merges
  against it. Any conflict is decided on that one device, as with `git pull`.
- **Adjacent lines** (with no unchanged line between your change and theirs) count as the same place, as in git. So
  does a long paragraph written on a single line: start sentences on new lines if you edit the same paragraph often.

## When this device cannot save

Edits are written to this device's storage a fraction of a second after you type. Whether they are *saved on this
device* is separate from whether co-authors have them. If a write fails (storage full, blocked, or an error in the
browser), HiveTeX:

- **keeps the edits in memory** and retries with a growing delay (half a second, doubling up to 30 seconds). Edits made
  meanwhile join the same retry, nothing is saved twice, and a failed write never stops later ones;
- **shows a persistent red warning** in the status bar ("Not saved on this device") and stops saying "Saved on this
  device"; peers can stay connected meanwhile, but they are not a backup of your last edits;
- offers **Export recovery copy**, a zip of the project as held in memory right now, including edits that storage
  refused. Files that cannot be read are listed in `RECOVERY-MISSING.txt` instead of stopping the export;
- asks before the tab is closed while edits are unsaved.

The warning goes away only after a retry has actually committed the retained edits. Exporting a copy does not clear it.
Free some space or restart the browser, keep the tab open, and watch the warning clear.

## Resolving conflicts

A red **N conflicts to resolve** in the status bar, the bar above a conflicting file, or the Sync panel opens
**Resolve conflicts**. For each conflict it shows your version, the co-authors' version and the text before either
change:

- **Keep mine**, **Keep theirs**, **Keep both** (yours first), or **Edit…** to write the result yourself.
- **Apply and share** becomes available when every conflict in the file is decided. The merged file is shared as your
  edit, and you can undo it like any edit.
- If co-authors changed the same lines again in the meantime, you are asked again; their newer changes elsewhere are
  kept.

Conflicts survive a restart. Closing the app with a conflict pending loses nothing.

## Under the hood

Each device keeps the last shared version of every document it changes while alone (the *base*), next to its own
data. When a peer connects, and before anything is exchanged, the device sets aside its own version ("mine") and puts
the base in place. Others therefore never receive offline edits half-merged. Once their version ("theirs") has
arrived, `packages/sync/src/fork.ts` merges base, mine and theirs with diff3 (`packages/sync/src/merge.ts`), and
applies the result as normal edits. Specs: `openspec/specs/peer-sync` (*Offline editing*, *Resolving merge conflicts*)
and `openspec/specs/local-mode`.

### Recovery journal

The recovery data of one offline merge is described by a *journal* (`fork:journal` in the project's metadata store)
with an operation id and a stage that only moves forward:

| Stage | Meaning |
|---|---|
| `forked` | Offline edits exist; the base of every changed document is saved; the documents still hold your version. |
| `prepared` | Your version ("mine"), the bases and the journal are saved, and the documents were replaced by their bases, in **one atomic storage transition**. |
| `reconciling` | The documents were exchanged with a peer; the merge is being applied. |
| `committed` | The merged documents and the conflicts are durable; only removing the recovery data is left. |

A crash at any point resumes from the stage on disk: before `prepared` your version is still the stored one, afterwards
it is in the "mine" copy; at `committed` the merge is not run again, so nothing is applied twice. The recovery data is
removed in one transition, only after the merged documents were written.

**Versions.** Earlier builds wrote a version-1 record (`fork`: stage `forked` or `merging`). It is still written next
to the journal and is read when there is no journal: it migrates *additively* (a `merging` record resumes as
`prepared`; every old record and copy stays as it was). If the migration write fails, nothing is lost and it is tried
again at the next step. A journal or record of a newer or unknown version is **never modified or deleted**: no new
offline merge starts over it until a build that understands it opens the project. Do not open a project with a pending
merge in an older build; export or finish the merge with a build that supports the journal first.
