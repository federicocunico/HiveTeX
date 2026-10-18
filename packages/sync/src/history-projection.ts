import * as Y from 'yjs';
import DiffMatchPatch from 'diff-match-patch';
import { fromB64u } from '@hivetex/crypto';
import type { TicketClaims } from '@hivetex/protocol';
import type { AuthoredOperation } from './authorship.js';
import type { ChangeSet, ChangeSetFile } from './persistence.js';
import { type OperationView, viewOf } from './operation-view.js';
const dmp = new DiffMatchPatch();

type Entry = Record<string, unknown>;
const live = (view: OperationView) => new Map(Object.entries(view.kind === 'root' ? view.maps.files ?? {} : {})
  .filter(([, e]) => !!e && typeof e === 'object' && !(e as Entry).deleted) as Array<[string, Entry]>);

/** Files changed between two projections of one document (paths are the ones recorded in the projections). */
export function projectViews(docId: string, before: OperationView, after: OperationView): ChangeSetFile[] {
  const files: ChangeSetFile[] = [];
  if (before.kind === 'text' && after.kind === 'text') {
    const a = before.text, b = after.text;
    if (a !== b) files.push({ fileId: docId.slice(2), path: `Recovered/${docId.slice(2)}.tex`, op: 'edit', before: a, after: b, patch: dmp.patch_toText(dmp.patch_make(a, b)) });
    return files;
  }
  const a = live(before), b = live(after);
  for (const [id, m] of b) {
    const prev = a.get(id), path = String(m.path);
    if (!prev) files.push({ fileId: id, path, op: 'create', before: '', after: '', ...(m.hash ? { hashAfter: String(m.hash) } : {}) });
    else {
      if (prev.path !== path) files.push({ fileId: id, path, from: String(prev.path), op: 'rename' });
      if (m.kind === 'binary' && m.hash !== prev.hash) files.push({ fileId: id, path, op: 'binary', hashBefore: String(prev.hash), hashAfter: String(m.hash), sizeBefore: Number(prev.size ?? 0) });
    }
  }
  for (const [id, m] of a) if (!b.has(id)) files.push({ fileId: id, path: String(m.path), op: 'delete', ...(m.hash ? { hashBefore: String(m.hash), sizeBefore: Number(m.size ?? 0) } : {}) });
  return files;
}

/**
 * What a signed update itself shows when no local preimage exists (retained history received from a peer): inserted
 * text, created entries and recoverable deletions. Removed text is not part of an update, so it is never invented, and
 * no `before`/`after` is recorded: an undo of such a group is reported as partial instead of guessing.
 */
function projectUpdate(docId: string, update: Uint8Array): ChangeSetFile[] {
  const { structs } = Y.decodeUpdate(update) as unknown as { structs: Array<{ id: Y.ID; parent?: unknown; parentSub?: string | null; content?: { str?: string; arr?: unknown[]; type?: unknown } }> };
  if (docId.startsWith('f:')) {
    const inserted = structs.map((s) => s.content?.str ?? '').join('');
    return inserted ? [{ fileId: docId.slice(2), path: `Recovered/${docId.slice(2)}.tex`, op: 'edit', patch: dmp.patch_toText(dmp.patch_make('', inserted)) }] : [];
  }
  const created = new Map<string, string>(), paths = new Map<string, string>(), files: ChangeSetFile[] = [];
  const key = (id: { client: number; clock: number }) => `${id.client}:${id.clock}`;
  for (const s of structs) {
    if (s.parent === 'files' && s.parentSub && s.content?.type) created.set(key(s.id), s.parentSub);
    if (s.parent && typeof s.parent === 'object' && s.parentSub === 'path' && typeof s.content?.arr?.[0] === 'string') paths.set(key(s.parent as Y.ID), s.content.arr[0]);
    const tomb = s.parent === 'tombstones' && s.parentSub ? s.content?.arr?.[0] as { entry?: Entry } | undefined : undefined;
    if (tomb?.entry?.path) files.push({ fileId: s.parentSub!, path: String(tomb.entry.path), op: 'delete', ...(tomb.entry.hash ? { hashBefore: String(tomb.entry.hash), sizeBefore: Number(tomb.entry.size ?? 0) } : {}) });
  }
  for (const [item, id] of created) files.push({ fileId: id, path: paths.get(item) ?? `Recovered/${id}`, op: 'create' });
  return files;
}

/**
 * Display history of a signed operation. `views` are this replica's own projections around applying it (live
 * operations); without them, a v1 envelope's signed preimage or else the update alone is used.
 */
export function projectAuthoredOperation(op: AuthoredOperation, author: Pick<TicketClaims, 'uname' | 'uid' | 'dev'>, views?: { before: OperationView; after: OperationView }): ChangeSet {
  let files: ChangeSetFile[];
  if (views) files = projectViews(op.docId, views.before, views.after);
  else if (op.v === 1 && op.before) {
    const before = new Y.Doc(), after = new Y.Doc();
    Y.applyUpdate(before, fromB64u(op.before));
    Y.applyUpdate(after, fromB64u(op.before));
    Y.applyUpdate(after, fromB64u(op.update));
    const a = viewOf(op.docId, before), b = viewOf(op.docId, after);
    files = a && b ? projectViews(op.docId, a, b) : [];
    before.destroy(); after.destroy();
  } else files = projectUpdate(op.docId, fromB64u(op.update));
  return { id: `authored:${op.id}`, source: authoredSource(op, author), startedAt: op.at, endedAt: op.at, files, operationIds: [op.id] };
}

export const authoredSource = (op: Pick<AuthoredOperation, 'source'>, author: Pick<TicketClaims, 'uname' | 'uid' | 'dev'>): ChangeSet['source'] =>
  ({ kind: 'peer', name: author.uname, uid: author.uid, device: author.dev, provenance: 'verified', origin: op.source });
