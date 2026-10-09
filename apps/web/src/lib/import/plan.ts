import { type BatchOp, type FileEntry, sha256Hex } from '@p2platex/sync';
import type { Engine } from './detect.js';
import type { ImportBundle, PreparedFile } from './sources.js';

export type ImportMode = 'merge' | 'replace';
export type Resolution = 'overwrite' | 'keep';

export interface PlanEntry {
  file: PreparedFile;
  /** Existing project entry at the same path (changed files only). */
  existing?: FileEntry;
}

export interface ImportPlan {
  added: PlanEntry[];
  changed: PlanEntry[];
  identical: string[];
  /** Project files not in the import (deleted only in replace mode). */
  removed: FileEntry[];
}

/** Reads an existing text file's content (only called for paths present in both the project and the import). */
export type TextReader = (id: string) => Promise<string>;

/** Compares an import with the current project tree. */
export async function planImport(bundle: ImportBundle, current: FileEntry[], readText: TextReader): Promise<ImportPlan> {
  const byPath = new Map(current.filter((f) => f.kind !== 'dir').map((f) => [f.path, f]));
  const plan: ImportPlan = { added: [], changed: [], identical: [], removed: [] };
  for (const file of bundle.files) {
    const existing = byPath.get(file.path);
    if (!existing) plan.added.push({ file });
    else if (await same(file, existing, readText)) plan.identical.push(file.path);
    else plan.changed.push({ file, existing });
  }
  const imported = new Set(bundle.files.map((f) => f.path));
  plan.removed = current.filter((f) => {
    if (f.kind === 'dir') return ![...imported].some((p) => p.startsWith(`${f.path}/`)) && !imported.has(f.path);
    return !imported.has(f.path);
  });
  return plan;
}

async function same(file: PreparedFile, existing: FileEntry, readText: TextReader): Promise<boolean> {
  if (file.kind !== existing.kind) return false;
  if (file.kind === 'text') return (await readText(existing.id)) === file.text;
  return !!existing.hash && existing.hash === (await sha256Hex(file.bytes));
}

export interface ApplyChoices {
  mode: ImportMode;
  /** Per-path choice for changed files; missing entries use `defaultResolution`. */
  resolutions: Map<string, Resolution>;
  defaultResolution: Resolution;
  /** Main file to set (undefined = leave as is). */
  main?: string | undefined;
  engine?: Engine | undefined;
}

export interface ApplyResult {
  added: number;
  overwritten: number;
  kept: number;
  identical: number;
  removed: number;
}

/** Stores binary content and returns its hash (the project's blob store). */
export type BlobWriter = (bytes: Uint8Array) => Promise<string>;

/**
 * Turns a confirmed plan into batch operations. Binary content is written to the blob store first (content-addressed,
 * so harmless if the batch never runs).
 */
export async function buildOps(plan: ImportPlan, choices: ApplyChoices, putBlob: BlobWriter, onProgress?: (done: number, total: number) => void) {
  const ops: BatchOp[] = [];
  const result: ApplyResult = { added: plan.added.length, overwritten: 0, kept: 0, identical: plan.identical.length, removed: 0 };
  const writes: PlanEntry[] = [...plan.added];
  for (const c of plan.changed) {
    const r = choices.mode === 'replace' ? 'overwrite' : (choices.resolutions.get(c.file.path) ?? choices.defaultResolution);
    if (r === 'overwrite') {
      writes.push(c);
      result.overwritten++;
    } else result.kept++;
  }
  if (choices.mode === 'replace') {
    for (const f of plan.removed) ops.push({ op: 'delete', id: f.id });
    result.removed = plan.removed.length;
  }
  let done = 0;
  for (const { file, existing } of writes) {
    // Same kind: overwrite in place (keeps identity). Different kind: replace the entry.
    const sameKind = existing && existing.kind === file.kind;
    if (existing && !sameKind) ops.push({ op: 'delete', id: existing.id });
    const id = sameKind ? { id: existing.id } : {};
    if (file.kind === 'text') ops.push({ op: 'text', path: file.path, text: file.text, ...id });
    else ops.push({ op: 'binary', path: file.path, hash: await putBlob(file.bytes), size: file.bytes.length, ...id });
    onProgress?.(++done, writes.length);
  }
  if (choices.main) ops.push({ op: 'setting', key: 'main', value: choices.main });
  if (choices.engine) ops.push({ op: 'setting', key: 'engine', value: choices.engine });
  return { ops, result };
}
