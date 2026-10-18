import diff from 'fast-diff';
import * as Y from 'yjs';

/**
 * Plain projection of a document that history needs: a file document's text, or the root's maps as JSON. Anything else
 * (an unknown shared type: a future format) has no projection and is journaled with a full state snapshot instead.
 */
export type OperationView = { kind: 'text'; text: string } | { kind: 'root'; maps: RootMaps };
export type RootMaps = Record<string, Record<string, unknown>>;

/** Root maps with a projection. A root document holding any other shared type falls back to full-state journaling. */
export const ROOT_MAPS = ['files', 'tombstones', 'settings', 'meta'] as const;

/**
 * Reversible change, proportional to the change: text edits `[at, removed, inserted]` with `at` in the text before
 * (ascending, disjoint), or root key changes `[map, key, before, after]` where `null` means absent.
 */
export type OperationDelta =
  | { kind: 'text'; edits: Array<[number, string, string]> }
  | { kind: 'root'; keys: Array<[string, string, Present | null, Present | null]> };
/** A present map value, boxed so JSON `null` values and absence stay distinct. */
export type Present = { v: unknown };

export function viewOf(docId: string, doc: Y.Doc): OperationView | null {
  if (docId === 'root') {
    if ([...doc.share.keys()].some((k) => !(ROOT_MAPS as readonly string[]).includes(k))) return null;
    const maps: RootMaps = {};
    for (const name of ROOT_MAPS) maps[name] = doc.getMap(name).toJSON() as Record<string, unknown>;
    return { kind: 'root', maps };
  }
  if ([...doc.share.keys()].some((k) => k !== 't')) return null;
  return { kind: 'text', text: doc.getText('t').toString() };
}

export function deltaOf(before: OperationView, after: OperationView): OperationDelta {
  if (before.kind === 'text' && after.kind === 'text') {
    const edits: Array<[number, string, string]> = [];
    let pos = 0;
    let open: [number, string, string] | null = null;
    for (const [op, chunk] of diff(before.text, after.text)) {
      if (op === diff.EQUAL) {
        if (open) edits.push(open);
        open = null;
        pos += chunk.length;
      } else {
        open ??= [pos, '', ''];
        if (op === diff.DELETE) { open[1] += chunk; pos += chunk.length; } else open[2] += chunk;
      }
    }
    if (open) edits.push(open);
    return { kind: 'text', edits };
  }
  if (before.kind !== 'root' || after.kind !== 'root') throw new Error('Operation view kind changed');
  const keys: Array<[string, string, Present | null, Present | null]> = [];
  for (const name of ROOT_MAPS) {
    const a = before.maps[name] ?? {}, b = after.maps[name] ?? {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const had = Object.prototype.hasOwnProperty.call(a, key), has = Object.prototype.hasOwnProperty.call(b, key);
      if (had && has && JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
      keys.push([name, key, had ? { v: a[key] } : null, has ? { v: b[key] } : null]);
    }
  }
  return { kind: 'root', keys };
}

/** Removed share of the previous content; above one half an operation is destructive and keeps a full preimage. */
export function removedShare(before: OperationView, delta: OperationDelta) {
  if (delta.kind === 'text') {
    const size = before.kind === 'text' ? before.text.length : 0;
    return size ? delta.edits.reduce((n, e) => n + e[1].length, 0) / size : 0;
  }
  const size = before.kind === 'root' ? Object.keys(before.maps.files ?? {}).length : 0;
  return size ? delta.keys.filter(([map, , was, now]) => map === 'files' && was && !now).length / size : 0;
}

/** `direction` 1 turns the view before into the view after; -1 turns the view after back into the view before. */
export function applyDelta(view: OperationView, delta: OperationDelta, direction: 1 | -1): OperationView {
  if (delta.kind === 'text') {
    if (view.kind !== 'text') throw new Error('Operation delta does not match its document');
    let out = '', cursor = 0, shift = 0;
    for (const [at, removed, inserted] of delta.edits) {
      const [from, to] = direction === 1 ? [removed, inserted] : [inserted, removed];
      const start = direction === 1 ? at : at + shift;
      if (start < cursor || view.text.slice(start, start + from.length) !== from) throw new Error('Operation delta does not match its document');
      out += view.text.slice(cursor, start) + to;
      cursor = start + from.length;
      shift += inserted.length - removed.length;
    }
    return { kind: 'text', text: out + view.text.slice(cursor) };
  }
  if (view.kind !== 'root') throw new Error('Operation delta does not match its document');
  const maps: RootMaps = {};
  for (const [name, values] of Object.entries(view.maps)) maps[name] = { ...values };
  for (const [name, key, was, now] of delta.keys) {
    maps[name] ??= {};
    const target = maps[name];
    const value = direction === 1 ? now : was;
    if (value) target[key] = value.v;
    else delete target[key];
  }
  return { kind: 'root', maps };
}

const encoder = new TextEncoder();
// JSON escapes lone surrogates (Yjs counts UTF-16 units, so a deletion can split a pair): the bytes stay lossless.
export const encodeView = (view: OperationView) => encoder.encode(JSON.stringify(view.kind === 'text' ? view.text : view.maps));
export function decodeView(docId: string, bytes: Uint8Array): OperationView {
  const text = new TextDecoder().decode(bytes);
  return docId === 'root' ? { kind: 'root', maps: JSON.parse(text) as RootMaps } : { kind: 'text', text: JSON.parse(text) as string };
}

/** A document holding exactly a view (consumers that read histories through Yjs accessors). */
export function docOfView(view: OperationView): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    if (view.kind === 'text') { doc.getText('t').insert(0, view.text); return; }
    for (const [name, values] of Object.entries(view.maps)) {
      const map = doc.getMap(name);
      for (const [key, value] of Object.entries(values)) {
        if (name === 'files' && value && typeof value === 'object' && !Array.isArray(value)) {
          const entry = new Y.Map<unknown>();
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) entry.set(k, v);
          map.set(key, entry);
        } else map.set(key, value);
      }
    }
  });
  return doc;
}
