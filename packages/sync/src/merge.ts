import { diff3Merge } from 'node-diff3';

/**
 * Git-style merge of work done while a device had no peer linked (design D2, D3): three-way by lines for text, and per
 * file id for the file list. Pure functions; the fork machinery (fork.ts) feeds them base / mine / theirs.
 */

/** Lines with their line endings, so joining them gives the text back exactly (CRLF and a missing final newline too). */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export interface ConflictHunk {
  base: string;
  mine: string;
  theirs: string;
}

/** Stable text or a conflict, in order: joining every region with its decision gives the merged file. */
export type MergeRegion = { ok: string } | { conflict: ConflictHunk };

export type TextMerge =
  /** Nothing to do: both sides equal (or only theirs changed: theirs is already shared). */
  | { kind: 'theirs'; text: string }
  /** Only this device changed the file: take its version. */
  | { kind: 'mine'; text: string }
  /** Both changed it in different places: merged automatically (worth a warning). */
  | { kind: 'clean'; text: string }
  /** Both changed the same lines. */
  | { kind: 'conflict'; regions: MergeRegion[] };

export function mergeText(base: string, mine: string, theirs: string): TextMerge {
  if (mine === theirs || mine === base) return { kind: 'theirs', text: theirs };
  if (theirs === base) return { kind: 'mine', text: mine };
  const blocks = diff3Merge(splitLines(mine), splitLines(base), splitLines(theirs), { excludeFalseConflicts: true });
  const regions: MergeRegion[] = blocks.map((b) =>
    b.conflict ? { conflict: { mine: b.conflict.a.join(''), base: b.conflict.o.join(''), theirs: b.conflict.b.join('') } } : { ok: (b.ok ?? []).join('') },
  );
  if (!regions.some((r) => 'conflict' in r)) return { kind: 'clean', text: regions.map((r) => ('ok' in r ? r.ok : '')).join('') };
  return { kind: 'conflict', regions };
}

/** How a conflict was decided: a side, both (mine first), or text written by the member. */
export type HunkDecision = 'mine' | 'theirs' | 'both' | { text: string };

const ensureNewline = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

export function decideHunk(h: ConflictHunk, d: HunkDecision): string {
  if (d === 'mine') return h.mine;
  if (d === 'theirs') return h.theirs;
  if (d === 'both') return ensureNewline(h.mine) + h.theirs;
  return d.text;
}

/** The merged text once every conflict has a decision (in region order). Throws if one is missing. */
export function applyDecisions(regions: MergeRegion[], decisions: Array<HunkDecision | undefined>): string {
  let i = 0;
  return regions
    .map((r) => {
      if ('ok' in r) return r.ok;
      const d = decisions[i++];
      if (d === undefined) throw new Error('conflict not decided');
      return decideHunk(r.conflict, d);
    })
    .join('');
}

export const conflictCount = (regions: MergeRegion[]) => regions.filter((r) => 'conflict' in r).length;

// ---------- file list (root document) ----------

/** What the merge needs to know about a file in a version of the project. `hash` = binary content id (null for text). */
export interface FileState {
  path: string;
  kind: 'text' | 'binary' | 'dir';
  hash: string | null;
}

export type FileList = Record<string, FileState>;

export type FileConflict =
  | { type: 'delete-modify'; id: string; deletedBy: 'mine' | 'theirs'; path: string }
  | { type: 'rename-rename'; id: string; mine: string; theirs: string }
  | { type: 'binary'; id: string; path: string; mine: string; theirs: string }
  | { type: 'add-add'; path: string; mineId: string; theirsId: string };

export interface FileListMerge {
  /** Changes to apply to the shared file list (theirs) right away. */
  add: Array<{ id: string; state: FileState }>;
  remove: string[];
  rename: Array<{ id: string; path: string }>;
  setHash: Array<{ id: string; hash: string }>;
  /** Text files changed on this device that still exist after the merge: their contents go through mergeText. */
  textToMerge: string[];
  conflicts: FileConflict[];
}

const changedContent = (a: FileState | undefined, b: FileState | undefined) => !!a && !!b && a.hash !== b.hash;

/**
 * Merges this device's file list (mine) into the shared one (theirs) against the last shared one (base), per file id
 * (stable across renames). `mineTextChanged` tells which text files this device edited during the fork.
 */
export function mergeFileLists(base: FileList, mine: FileList, theirs: FileList, mineTextChanged: Set<string>, theirsTextChanged: Set<string>): FileListMerge {
  const out: FileListMerge = { add: [], remove: [], rename: [], setHash: [], textToMerge: [], conflicts: [] };
  const ids = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
  const theirsPaths = new Map(Object.entries(theirs).map(([id, f]) => [f.path, id]));
  for (const id of ids) {
    const b = base[id];
    const m = mine[id];
    const t = theirs[id];
    if (!b) {
      // added here (and maybe there with the same id, which cannot happen for new ids)
      if (m && !t) {
        const clash = theirsPaths.get(m.path);
        if (clash && clash !== id) out.conflicts.push({ type: 'add-add', path: m.path, mineId: id, theirsId: clash });
        else {
          out.add.push({ id, state: m });
          if (m.kind === 'text') out.textToMerge.push(id);
        }
      }
      continue;
    }
    if (!m && !t) continue; // deleted on both sides
    if (!m && t) {
      // deleted here: keep the delete unless they changed the file meanwhile
      const theyChanged = t.kind === 'text' ? theirsTextChanged.has(id) : changedContent(b, t);
      if (theyChanged) out.conflicts.push({ type: 'delete-modify', id, deletedBy: 'mine', path: t.path });
      else out.remove.push(id);
      continue;
    }
    if (m && !t) {
      const iChanged = m.kind === 'text' ? mineTextChanged.has(id) : changedContent(b, m);
      if (iChanged) out.conflicts.push({ type: 'delete-modify', id, deletedBy: 'theirs', path: m.path });
      continue; // otherwise their delete stands
    }
    if (!m || !t) continue;
    // present everywhere: path, then content
    if (m.path !== b.path) {
      if (t.path === b.path) out.rename.push({ id, path: m.path });
      else if (t.path !== m.path) out.conflicts.push({ type: 'rename-rename', id, mine: m.path, theirs: t.path });
    }
    if (m.kind === 'binary' && m.hash !== b.hash) {
      if (t.hash === b.hash) out.setHash.push({ id, hash: m.hash as string });
      else if (t.hash !== m.hash) out.conflicts.push({ type: 'binary', id, path: t.path, mine: m.hash as string, theirs: t.hash as string });
    }
    if (m.kind === 'text' && mineTextChanged.has(id)) out.textToMerge.push(id);
  }
  return out;
}
