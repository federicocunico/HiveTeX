import { type BlobManager, type Mesh, type ProjectModel, acquireProject, projectHash, pathCollisions } from '@hivetex/sync';
import { ROOT_DOC_ID } from '@hivetex/protocol';
import type { TexEngine } from './capability.js';
import { parseLog } from './logparser.js';
import { type CompileEngine, type CompileInput, type CompileResult, IncompleteInputError, computeStateHash } from './pipeline.js';

export interface LocalBuild {
  result: CompileResult;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
}

/** Foreground-only build service. Project content may be acquired from sync; generated results never enter it. */
export class LocalCompiler {
  latest: LocalBuild | null = null;
  lastGood: LocalBuild | null = null;
  private running: Promise<LocalBuild> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private stopped = false;
  private seq = 0;
  private engineRevision = 0;
  private builtRevision = -1;
  private firstAt = 0;
  private results = new Set<(build: LocalBuild) => void>();
  private states = new Set<(running: boolean) => void>();
  private unsubs: Array<() => void>;

  constructor(private o: {
    mesh: Mesh; model: ProjectModel; blobs: BlobManager; engine: CompileEngine;
    self: { dev: string; uname: string };
    automatic?: () => boolean;
    debounceMs?: number; maxWaitMs?: number; timeoutMs?: number; acquireTimeoutMs?: number; assetTimeoutMs?: number;
  }) {
    this.unsubs = [
      o.model.onDocUpdate(() => this.schedule()),
      o.model.onAvailability(() => this.schedule()),
      o.blobs.onStored(() => { if (this.latest?.result.incomplete) this.schedule(0); }),
    ];
  }

  onResult(cb: (build: LocalBuild) => void) { this.results.add(cb); return () => this.results.delete(cb); }
  onState(cb: (running: boolean) => void) { this.states.add(cb); return () => this.states.delete(cb); }

  schedule(delay = this.o.debounceMs ?? 1200) {
    if (this.stopped || this.o.automatic?.() === false) return;
    const now = Date.now();
    if (!this.timer) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run().catch(() => {});
    }, Math.min(delay, Math.max(0, this.firstAt + (this.o.maxWaitMs ?? 5000) - now)));
  }

  compilerSwitched() { this.engineRevision++; this.schedule(0); }

  async snapshot(): Promise<CompileInput> {
    const got = await acquireProject(this.o.mesh, this.o.model, this.o.blobs, {
      timeoutMs: this.o.acquireTimeoutMs ?? 8000, assetTimeoutMs: this.o.assetTimeoutMs ?? 8000,
    });
    if (!got.complete) throw new IncompleteInputError(got.missing);
    const collisions = pathCollisions(got.capture.files);
    if (collisions.size) throw new Error(`Cannot build ambiguous file paths: ${[...collisions].join(', ')}. Rename the conflicting paths before compiling.`);
    const files: CompileInput['files'] = [];
    for (const f of got.capture.files) {
      if (f.kind === 'text') files.push({ path: f.path, kind: 'text', text: f.text ?? '' });
      else if (f.kind === 'binary') files.push({ path: f.path, kind: 'binary', bytes: got.assets.get(f.hash ?? '') as Uint8Array });
    }
    return { files, main: got.capture.settings.main, engine: got.capture.settings.engine as TexEngine, stateHash: await projectHash(got.capture) };
  }

  async isStale(): Promise<boolean> {
    if (!this.lastGood || this.builtRevision !== this.engineRevision || this.o.model.availability(ROOT_DOC_ID) !== 'complete' || this.o.model.missingText().length) return true;
    return this.lastGood.result.stateHash !== await computeStateHash(this.o.model);
  }

  /** Requests share a running build, then recheck current inputs, so edits during a build get one subsequent build. */
  async run(): Promise<LocalBuild> {
    if (this.stopped) throw new Error('Editor detached');
    if (this.running) { await this.running; return this.run(); }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = this.build();
    this.running = run;
    try { return await run; }
    finally { if (this.running === run) this.running = null; }
  }

  private async build(): Promise<LocalBuild> {
    this.abort = new AbortController();
    const abort = this.abort;
    const revision = this.engineRevision;
    let input: CompileInput | undefined;
    for (const cb of this.states) cb(true);
    try {
      input = await this.snapshot();
      if (this.stopped) throw new Error('Editor detached');
      if (this.latest?.result.ok && this.latest.result.stateHash === input.stateHash && this.builtRevision === revision) return this.latest;
      if (!this.o.engine.supports.includes(input.engine)) throw new Error(`This device cannot run ${input.engine}. Set up a compatible local compiler.`);
      const output = await this.o.engine.compile(input, { timeoutMs: this.o.timeoutMs ?? 120_000, signal: abort.signal });
      if (this.stopped || abort.signal.aborted) throw new Error('Build cancelled');
      const build: LocalBuild = {
        result: { stateHash: input.stateHash, ok: output.ok && !!output.pdf, diagnostics: parseLog(output.log, input.main), log: output.log.slice(-40_000), by: this.o.self, at: Date.now(), seq: ++this.seq },
        ...(output.pdf ? { pdf: output.pdf } : {}), ...(output.synctex ? { synctex: output.synctex } : {}),
      };
      if (build.result.ok) { this.lastGood = build; this.builtRevision = revision; }
      return this.publish(build);
    } catch (e) {
      if (this.stopped) throw e;
      const message = e instanceof Error ? e.message : String(e);
      return this.publish({ result: {
        stateHash: input?.stateHash ?? '', ok: false, diagnostics: [], log: `! Local compile failed: ${message}`,
        ...(e instanceof IncompleteInputError ? { incomplete: e.missing.map((m) => m.path) } : {}),
        by: this.o.self, at: Date.now(), seq: ++this.seq,
      } });
    } finally {
      if (this.abort === abort) this.abort = null;
      for (const cb of this.states) cb(false);
    }
  }

  private publish(build: LocalBuild) {
    this.latest = build;
    for (const cb of this.results) cb(build);
    return build;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    for (const off of this.unsubs.splice(0)) off();
    this.results.clear(); this.states.clear();
  }
}
