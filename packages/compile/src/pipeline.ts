import { type MissingContent, type ProjectModel, describeMissing, projectHash, projectSettings } from '@hivetex/sync';
import type { EngineKind, TexEngine } from './capability.js';
import type { Diagnostic } from './logparser.js';

export interface CompileInput {
  files: Array<{ path: string; kind: 'text' | 'binary'; text?: string; bytes?: Uint8Array }>;
  main: string;
  engine: TexEngine;
  stateHash: string;
}

export interface CompileOutput {
  ok: boolean;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
  log: string;
}

export interface CompileEngine {
  kind: EngineKind;
  supports: TexEngine[];
  /** Aborting `signal` stops the build: the worker or the native process tree ends, and the promise settles. */
  compile(input: CompileInput, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<CompileOutput>;
  /** Checks again for engines that were unavailable (a TeX file server that did not answer). */
  refresh?(): Promise<void>;
  /** Releases the workers or processes held for the session that loaded this engine. */
  dispose?(): void;
}

export interface CompileResult {
  stateHash: string;
  ok: boolean;
  diagnostics: Diagnostic[];
  log: string;
  /** Set when nothing was built because these project files were not available yet (never with `ok`). */
  incomplete?: string[];
  by: { dev: string; uname: string };
  at: number;
  seq: number;
}

export const settings = {
  main: (m: ProjectModel) => projectSettings(m).main,
  engine: (m: ProjectModel) => projectSettings(m).engine as TexEngine,
};

/** Thrown when the project's files are not all available on this device (and the peers could not supply them). */
export class IncompleteInputError extends Error {
  constructor(readonly missing: MissingContent[]) {
    super(`Cannot build yet: these project files are not available on this device: ${describeMissing(missing)}`);
    this.name = 'IncompleteInputError';
  }
}

/**
 * Identity of what a build reads: paths, file contents (images by hash), main file and engine; independent of CRDT
 * internals. It describes the project as it is now, so it is only comparable with a result's identity when the
 * project is complete here (missing text would have to be hashed as empty, which is exactly what a result must never claim).
 */
export async function computeStateHash(model: ProjectModel): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await Promise.all(model.list().filter((f) => f.kind === 'text').map((f) => model.openText(f.id)));
    const seq = model.changeSeq;
    const entries = model.list();
    if (model.missingText().length || entries.some((f) => f.kind === 'text' && !model.getLoadedDoc(`f:${f.id}`))) throw new Error('Project text is incomplete');
    const files: Parameters<typeof projectHash>[0]['files'] = entries.map((f) => f.kind === 'text'
      ? { id: f.id, path: f.path, kind: 'text', text: model.getLoadedDoc(`f:${f.id}`)!.getText('t').toString() }
      : { id: f.id, path: f.path, kind: f.kind, ...(f.hash ? { hash: f.hash } : {}) });
    const hash = await projectHash({ files: files.filter((f) => f.kind !== 'binary' || f.hash), settings: projectSettings(model), seq });
    if (seq === model.changeSeq) return hash;
  }
  throw new Error('Project changed while checking the result identity');
}
