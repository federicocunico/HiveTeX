import { ROOT_DOC_ID, fileDocId } from '@hivetex/protocol';
import type { BlobManager } from './blobs.js';
import type { Mesh, ReconcileOptions } from './mesh.js';
import { type ProjectModel, sha256Hex } from './model.js';

export const DEFAULT_MAIN = 'main.tex';
export const DEFAULT_ENGINE = 'pdflatex';

/** The project settings that decide what a build or export means. */
export function projectSettings(model: ProjectModel): { main: string; engine: string } {
  return { main: String(model.settings.get('main') ?? DEFAULT_MAIN), engine: String(model.settings.get('engine') ?? DEFAULT_ENGINE) };
}

export interface CapturedFile {
  id: string;
  path: string;
  kind: 'text' | 'binary' | 'dir';
  /** Text content as of the capture. */
  text?: string;
  /** Content hash of a binary file (its bytes are fetched by it). */
  hash?: string;
  size?: number;
  /** The text document's revision at the capture (`ProjectModel.revision`). */
  revision?: number;
}

/** An immutable copy of everything a build, export or backup reads, taken in one synchronous step. */
export interface ProjectCapture {
  files: CapturedFile[];
  settings: { main: string; engine: string };
  /** `ProjectModel.changeSeq` at the capture: edits with a higher number are not included. */
  seq: number;
  /** Local wall clock at the synchronous capture, before waiting for binary inputs. */
  at: number;
}

export interface MissingContent {
  path: string;
  kind: 'text' | 'binary' | 'project';
  /** Content hash, for a binary. */
  hash?: string;
  /** Why it is missing: how the last round with the peers ended, or `local` when nobody could be asked. */
  outcome: string;
}

export type Acquisition =
  | { complete: true; capture: ProjectCapture; /** Binary content by hash, for every binary in the capture. */ assets: Map<string, Uint8Array> }
  | { complete: false; missing: MissingContent[] };

export interface AcquireOptions extends ReconcileOptions {
  /** Skip fetching binary content (the identity and the text do not need it). Default: fetch. */
  assets?: boolean;
  /** Per asset (default 15 s). */
  assetTimeoutMs?: number;
}

const BINARY_PARALLEL = 3;

/**
 * Takes the capture without waiting for anything, from documents already loaded; `undefined` when a text file's
 * document is not loaded or complete (the caller then waits or reports it).
 */
function captureNow(model: ProjectModel): { capture: ProjectCapture } | { missing: MissingContent[]; unloaded: boolean } {
  const missing: MissingContent[] = [];
  if (model.availability(ROOT_DOC_ID) !== 'complete') missing.push({ path: '(file list)', kind: 'project', outcome: 'local' });
  const files: CapturedFile[] = [];
  let unloaded = false;
  for (const f of model.list()) {
    if (f.kind === 'text') {
      const docId = fileDocId(f.id);
      const doc = model.getLoadedDoc(docId);
      if (model.availability(docId) !== 'complete') missing.push({ path: f.path, kind: 'text', outcome: 'local' });
      else if (!doc) unloaded = true;
      else files.push({ id: f.id, path: f.path, kind: 'text', text: doc.getText('t').toString(), revision: model.revision(docId) });
    } else if (f.kind === 'binary') {
      if (f.hash) files.push({ id: f.id, path: f.path, kind: 'binary', hash: f.hash, ...(f.size !== undefined ? { size: f.size } : {}) });
    } else files.push({ id: f.id, path: f.path, kind: 'dir' });
  }
  if (missing.length || unloaded) return { missing, unloaded };
  return { capture: { files, settings: projectSettings(model), seq: model.changeSeq, at: Date.now() } };
}

/**
 * The project's file table, every text body and every binary, or the list of what is not available. Waits (up to
 * the options' timeout) for the peers to supply what is missing, never substitutes empty text, and works offline
 * for a project that is complete on this device. The text and settings are fixed in one synchronous step after
 * the waiting; assets are then fetched by the captured hashes, so edits made meanwhile cannot change the capture.
 */
export async function acquireProject(mesh: Mesh, model: ProjectModel, blobs: BlobManager, opts: AcquireOptions = {}): Promise<Acquisition> {
  const rec = await mesh.awaitComplete(opts);
  const outcomes = new Map(rec.missing.map((m) => [m.path ?? '(file list)', m.outcome] as const));
  let capture: ProjectCapture | undefined;
  for (let attempt = 0; attempt < 5 && !capture; attempt++) {
    // Documents are loaded lazily; load them all, then capture without another await.
    try {
      await model.getDoc(ROOT_DOC_ID);
      await Promise.all(model.list().filter((f) => f.kind === 'text' && model.availability(fileDocId(f.id)) === 'complete').map((f) => model.getDoc(fileDocId(f.id))));
    } catch {
      return { complete: false, missing: [{ path: '(project storage)', kind: 'project', outcome: 'unreadable' }] };
    }
    const got = captureNow(model);
    if ('capture' in got) capture = got.capture;
    else if (got.missing.length) return { complete: false, missing: got.missing.map((m) => ({ ...m, outcome: outcomes.get(m.path) ?? m.outcome })) };
  }
  if (!capture) return { complete: false, missing: [{ path: '(project)', kind: 'project', outcome: 'changing' }] };

  const assets = new Map<string, Uint8Array>();
  if (opts.assets === false) return { complete: true, capture, assets };
  const byHash = new Map<string, string[]>();
  for (const f of capture.files) if (f.kind === 'binary' && f.hash) byHash.set(f.hash, [...(byHash.get(f.hash) ?? []), f.path]);
  const queue = [...byHash.keys()];
  const failed: MissingContent[] = [];
  const worker = async () => {
    for (let h = queue.shift(); h; h = queue.shift()) {
      try {
        assets.set(h, await blobs.fetch(h, opts.assetTimeoutMs ?? 15_000));
      } catch {
        for (const path of byHash.get(h) ?? []) failed.push({ path, kind: 'binary', hash: h, outcome: 'unavailable' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BINARY_PARALLEL, queue.length) }, worker));
  if (failed.length) return { complete: false, missing: failed.sort((a, b) => (a.path < b.path ? -1 : 1)) };
  return { complete: true, capture, assets };
}

/** Identity of a capture: its paths, contents (binary: hashes) and settings, and nothing about CRDT internals or the live model. */
export async function projectHash(capture: ProjectCapture): Promise<string> {
  const enc = new TextEncoder();
  const parts: string[] = [`settings\0${capture.settings.main}\0${capture.settings.engine}`];
  for (const f of capture.files) {
    const h = f.kind === 'text' ? await sha256Hex(enc.encode(f.text ?? '')) : (f.hash ?? '');
    parts.push(`${f.kind}\0${f.path}\0${h}`);
  }
  parts.sort();
  return sha256Hex(enc.encode(parts.join('\n')));
}

/** Text of a missing-content list for an error message. */
export function describeMissing(missing: MissingContent[], max = 5): string {
  const names = missing.map((m) => m.path);
  return names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', ');
}
