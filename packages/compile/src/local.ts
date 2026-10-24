import { type BlobManager, type Mesh, type ProjectModel, acquireProject, projectHash, pathCollisions } from '@hivetex/sync';
import { ROOT_DOC_ID } from '@hivetex/protocol';
import type { TexEngine } from './capability.js';
import { parseLog } from './logparser.js';
import { explainFailure } from './failure.js';
import { type CompileEngine, type CompileInput, type CompileResult, IncompleteInputError, computeStateHash } from './pipeline.js';

export interface LocalBuild {
  result: CompileResult;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
  source?: { seq: number; at: number; engine: TexEngine; stateHash: string };
}
export type CompileSchedule = 'after-changes' | 'periodic' | 'manual';

/** Foreground-only build service. Project content may be acquired from sync; generated results never enter it. */
export class LocalCompiler {
  latest: LocalBuild | null = null;
  lastGood: LocalBuild | null = null;
  private running: Promise<LocalBuild> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private mode: CompileSchedule = 'after-changes';
  private periodSeconds = 30;
  private pending: { explicit: boolean; promise: Promise<LocalBuild>; resolve: (build: LocalBuild) => void; reject: (e: unknown) => void } | null = null;
  private inputRevision = 0;
  private attemptedRevision = -1;
  private abort: AbortController | null = null;
  private stopped = false;
  private seq = 0;
  private engineRevision = 0;
  private builtRevision = -1;
  private firstAt = 0;
  private results = new Set<(build: LocalBuild) => void>();
  private states = new Set<(running: boolean) => void>();
  private schedules = new Set<(waiting: boolean) => void>();
  private unsubs: Array<() => void>;

  constructor(private o: {
    mesh: Mesh; model: ProjectModel; blobs: BlobManager; engine: CompileEngine;
    self: { dev: string; uname: string };
    automatic?: () => boolean;
    debounceMs?: number; maxWaitMs?: number; timeoutMs?: number; acquireTimeoutMs?: number; assetTimeoutMs?: number;
  }) {
    this.unsubs = [
      o.model.onDocUpdate(() => this.changed()),
      o.model.onAvailability(() => this.changed()),
      o.blobs.onStored(() => { if (this.latest?.result.incomplete) this.changed(); }),
    ];
  }

  onResult(cb: (build: LocalBuild) => void) { this.results.add(cb); return () => this.results.delete(cb); }
  onState(cb: (running: boolean) => void) { this.states.add(cb); return () => this.states.delete(cb); }
  onSchedule(cb: (waiting: boolean) => void) { this.schedules.add(cb); return () => this.schedules.delete(cb); }
  get waiting() { return !!(this.timer || this.pending); }
  private notifySchedule() { for (const cb of this.schedules) cb(this.waiting); }
  private get automatic() { return !this.stopped && this.mode !== 'manual' && this.o.automatic?.() !== false; }
  private changed() { this.inputRevision++; this.schedule(); }

  /** Device preference changes cancel only automatic work; an explicit request and an active build survive. */
  setSchedule(mode: CompileSchedule, intervalSeconds = 30) {
    if (this.stopped) return;
    if (!['after-changes', 'periodic', 'manual'].includes(mode)) throw new Error('Invalid compilation schedule');
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 300) throw new Error('Compilation interval must be 5–300 whole seconds');
    if (this.mode === mode && this.periodSeconds === intervalSeconds && (mode !== 'periodic' || this.interval)) return;
    this.mode = mode;
    this.periodSeconds = intervalSeconds;
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = this.interval = null;
    if (this.pending && !this.pending.explicit) {
      const cancelled = this.pending;
      this.pending = null;
      // Its callers asked for automatic work; let the active result satisfy them without another build.
      this.running?.then(cancelled.resolve, cancelled.reject);
    }
    if (mode === 'periodic') this.interval = setInterval(() => {
      if (this.automatic) void this.run(false).catch(() => {});
    }, intervalSeconds * 1000);
    if (mode === 'after-changes') this.schedule(0);
    this.notifySchedule();
  }

  schedule(delay = this.o.debounceMs ?? 1500) {
    if (!this.automatic || this.mode !== 'after-changes') return;
    const now = Date.now();
    if (!this.timer) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.notifySchedule();
      void this.run(false).catch(() => {});
    }, Math.min(delay, Math.max(0, this.firstAt + (this.o.maxWaitMs ?? 5000) - now)));
    this.notifySchedule();
  }

  compilerSwitched() { this.engineRevision++; this.inputRevision++; this.schedule(0); }

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
    return { files, main: got.capture.settings.main, engine: got.capture.settings.engine as TexEngine, stateHash: await projectHash(got.capture), capture: { seq: got.capture.seq, at: got.capture.at } };
  }

  async isStale(): Promise<boolean> {
    if (!this.lastGood || this.builtRevision !== this.engineRevision || this.o.model.availability(ROOT_DOC_ID) !== 'complete' || this.o.model.missingText().length) return true;
    return this.lastGood.result.stateHash !== await computeStateHash(this.o.model);
  }

  /** All requests during a build share one pending promise and one subsequent snapshot of the latest inputs. */
  run(explicit = true): Promise<LocalBuild> {
    if (this.stopped) return Promise.reject(new Error('Editor detached'));
    if (this.running) {
      if (!this.pending) {
        let resolve!: (build: LocalBuild) => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise<LocalBuild>((yes, no) => { resolve = yes; reject = no; });
        this.pending = { explicit, promise, resolve, reject };
      } else this.pending.explicit ||= explicit;
      this.notifySchedule();
      return this.pending.promise;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = Promise.resolve().then(() => this.build(explicit));
    this.running = run;
    this.notifySchedule();
    const finish = () => {
      if (this.running !== run) return;
      this.running = null;
      const next = this.pending;
      this.pending = null;
      this.notifySchedule();
      if (!next) return;
      if (this.stopped) next.reject(new Error('Editor detached'));
      else if (next.explicit || this.automatic) this.run(next.explicit).then(next.resolve, next.reject);
      else run.then(next.resolve, next.reject);
    };
    void run.then(finish, finish);
    return run;
  }

  private async build(explicit: boolean): Promise<LocalBuild> {
    if (this.stopped) throw new Error('Editor detached');
    if (!explicit && !this.automatic) throw new Error('Automatic compilation disabled');
    if (!explicit && this.latest && this.attemptedRevision === this.inputRevision) return this.latest;
    this.abort = new AbortController();
    const abort = this.abort;
    const revision = this.engineRevision;
    const inputRevision = this.inputRevision;
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
        ...(input.capture ? { source: { ...input.capture, engine: input.engine, stateHash: input.stateHash } } : {}),
      };
      if (!build.result.ok) build.result.failure = explainFailure(output.log, build.result.diagnostics);
      if (build.result.ok) { this.lastGood = build; this.builtRevision = revision; }
      this.attemptedRevision = inputRevision;
      return this.publish(build);
    } catch (e) {
      if (this.stopped) throw e;
      this.attemptedRevision = inputRevision;
      const message = e instanceof Error ? e.message : String(e);
      return this.publish({ result: {
        stateHash: input?.stateHash ?? '', ok: false, diagnostics: [], log: `! Local compile failed: ${message}`,
        ...(e instanceof IncompleteInputError ? { incomplete: e.missing.map((m) => m.path) } : {}),
        failure: explainFailure(message, [], e instanceof IncompleteInputError ? e.missing.map((m) => m.path) : []),
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
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
    this.pending?.reject(new Error('Editor detached'));
    this.pending = null;
    this.abort?.abort();
    for (const off of this.unsubs.splice(0)) off();
    this.results.clear(); this.states.clear(); this.schedules.clear();
  }
}
