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

## Starting without the server

A shared project that is already on this device opens and is editable when the server cannot be reached. Which parts
exist locally is handled separately, and each missing part is recovered on its own:

| Part | Offline start | When the server is reachable again |
|---|---|---|
| Device keys and, if it was registered before, its device id | read from this device; a registered device keeps its identity | nothing to do |
| Registration (a device that was never registered) | skipped, a temporary id is used and **nothing is requested with it** | registered once (concurrent requests share one), then the id replaces the temporary one everywhere |
| Trusted ticket keys | the copy cached in this browser tab, if any | loaded into the same list the connections verify with |
| Membership ticket | none | requested; the first one starts peer discovery |

Recovery needs no reload: it is tried every 15 s and immediately when the browser reports that it is online again, and
the edits made meanwhile are merged like any other offline work (see above). A refusal while registering or loading keys
is treated as "server unreachable", never as removal from the project: only a refusal of the ticket request itself, for a
registered device, shows the access-removed state. *Work offline* and closing the project stop these requests and cancel
a ticket request in flight, so a late answer starts nothing; *Resume* asks again. A local project (no account) makes no
server request at all. Specs: `openspec/specs/peer-sync` (*Automatic synchronization recovery*, *Connection lifecycle
isolation*); tests: `apps/web/test/session-recovery.test.ts`.

## What is here, what is saved, what is current

The status bar and the Sync panel keep three things apart:

- **Available on this device:** the complete content of a file is here. A file that is only *listed* (its name arrived, its
  text did not) is not available, and is never shown to other features as an empty file. A file you created, or one a
  co-author confirmed (an empty file included), is available, and stays so after reopening, also offline.
- **Saved on this device:** your edits are written to local storage ("Saved on this device"; a red warning if not, see below).
- **Current with co-authors:** the co-authors connected right now answered for the file. A project reopened from its cached
  copy is fully usable, but says **Checking with co-authors: N of M files** until they answered, and **All changes synced**
  only after that. The *Last synced* time moves only when such an answer arrived, never because a request was queued.

**Sync now** asks every connected co-author again for every file and waits for the answers. It says *Everything is up to
date* only when they all answered; if a co-author does not answer in time it says so (*No answer yet … Your edits are kept*),
and if nobody holds a file it says that too. Nothing you wrote is touched by any of these outcomes.

Two same-name files are only merged into one when both are complete and identical at that moment, and a file whose text has
not arrived is never taken for an empty one. Source export, compilation, GitHub backup, History snapshots and
folder mirroring follow the same rule: they wait for the missing files, or name them, and never use an empty stand-in. A project that
is complete on this device can still be exported, compiled and backed up (as far as GitHub is reachable) with nobody online.
*Download project (.zip)* says which files have not arrived instead of downloading a partial archive; History does not record a
snapshot, and *Undo* in Changes refuses, while text is missing. See `docs/compilation.md` and `docs/github-backup.md`.

Older HiveTeX versions do not send the receipts that make this exact. With such a co-author the app falls back to the plain
exchange: one request per file at a time, a reply counts, and an unrelated live update never does. This is slower to settle and
cannot tell whether that co-author's own copy is whole. Specs: `openspec/specs/peer-sync` (*Explicit document availability*,
*Sync progress visibility*, *Manual sync*, *Safe identical-file consolidation*); wire details in `docs/protocol.md`
(*Availability and reconciliation*); tests: `packages/sync/test/{availability,reconcile,sync-retry,sync-outcome}.test.ts`.

### Known limit: several tabs

Opening the same project in several tabs of the same browser profile is not supported. The tabs share one stored device
identity, a new connection from one tab replaces the other's, and the tabs do not coordinate saving. Keep one tab per
project.

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
the base in place. Others therefore never receive offline edits half-merged. Once the connected co-authors have
**confirmed** their version ("theirs", see below), `packages/sync/src/fork.ts` merges base, mine and theirs with diff3 (`packages/sync/src/merge.ts`), and
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

The same stages describe an **interrupted merge**: restart, a lost link or a failed write at any point resumes from the stage on disk, and the next link runs the exchange again.
A crash at any point resumes from the stage on disk: before `prepared` your version is still the stored one, afterwards
it is in the "mine" copy; at `committed` the merge is not run again, so nothing is applied twice. The recovery data is
removed in one transition, only after the merged documents were written.

**Versions.** Earlier builds wrote a version-1 record (`fork`: stage `forked` or `merging`). It is still written next
to the journal and is read when there is no journal: it migrates *additively* (a `merging` record resumes as
`prepared`; every old record and copy stays as it was). If the migration write fails, nothing is lost and it is tried
again at the next step. A journal or record of a newer or unknown version is **never modified or deleted**: no new
offline merge starts over it until a build that understands it opens the project. Do not open a project with a pending
merge in an older build; export or finish the merge with a build that supports the journal first.

**Rollback.** Going back to an older build is safe only while no merge is pending: with a journal present the recovery
data must stay (the base, "mine" and journal records are never deleted by a build that does not finish the merge). A
version-1 build reads the mirrored record (`forked` before preparation, `merging` afterwards) and finds the same copies,
but it does not know the stage `reconciling` or `committed`, nor that a merge may be applied again without duplicating
work. If you must roll back with a pending merge, finish it first in a build that supports the journal (reconnect to a
co-author, or resolve the conflicts), or export a recovery copy. Fixtures for every path above are in
`packages/sync/test/fork-journal.test.ts` (restart from each stage, version-1 migration, unknown journals kept untouched).

### The merge waits for confirmation

A merge only uses the co-authors' state when it was **confirmed for this attempt**: a connected co-author who can edit
answered the request made after this link was set up, saying its copy of the file is complete. Nothing else counts: not a
live update, not a late answer to an earlier link, not a timeout. If the file table or a file does not arrive in time
(slow link, nobody holds it, the link drops, a co-author who may only view), the merge **stays pending** with all its
recovery data. Nothing of the merge is applied until every file it needs is confirmed, so a failure never leaves a half-merged
project. While a co-author stays linked the attempt is repeated every few seconds; a new link starts over from the journal.
The Sync panel says *Your offline changes are kept and waiting for a co-author to confirm the project*.

A **viewer** can neither confirm state nor hold work to merge with yours. When the first co-author to link is a viewer,
your offline work is therefore shared as it is, at once, and an editor who joins later merges against it. (A member who can
no longer edit never takes this path: the work is dropped, see below.) The trade-off: if an editor who is not linked yet
changed the same lines meanwhile, the conflict shows up when that editor links, not right away. Waiting for an editor
instead would keep your work unshared for as long as none is online. Spec: `openspec/specs/peer-sync` (*Offline work when
only viewers are linked*).

If preparing the merge fails (for example the recovery copy cannot be saved, or a document cannot be read), **no document is
exchanged on that link**: the link is closed instead, so the others never see unmerged offline work, and the next link
retries from the journal. Seeing who is online keeps working meanwhile.

### Typing while merging

You can keep typing during every step. Your version is captured and replaced in one synchronous step: a keystroke lands
either in the captured version or in the document that replaces it, never in between, and the latter is stored with the
replacement and merged with your offline text (restart included). The editor is bound to the new document in place and
is not rebuilt when the file list changes, so no keystroke falls between the two (`e2e/offline-merge.spec.ts`). While conflicts wait, what you type elsewhere in the
file is kept when you decide; if you type in the conflicting lines, you are asked again. A decision applied just before a
crash is recognised when you decide again, and does not apply twice.

### If you lose edit rights while working offline

The explicit policy is unchanged: the work done offline is **not shared** and is dropped when the merge runs (the
status bar says so); it never reaches anyone, not even when the other device would have shared its own work as it is. Pending
conflicts stay, but their decisions cannot be applied by a member who may no longer edit the project.
