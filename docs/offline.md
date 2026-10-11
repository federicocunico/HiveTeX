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
