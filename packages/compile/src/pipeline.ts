import {
  type BlobManager,
  type Mesh,
  type MissingContent,
  type PeerInfo,
  type ProjectModel,
  acquireProject,
  describeMissing,
  projectHash,
  projectSettings,
} from '@hivetex/sync';
import type { EngineKind, TexEngine } from './capability.js';
import type { Election } from './election.js';
import { type Diagnostic, parseLog } from './logparser.js';

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
  compile(input: CompileInput, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<CompileOutput>;
}

export interface CompileResult {
  stateHash: string;
  ok: boolean;
  pdfHash?: string;
  synctexHash?: string;
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
  const files: Parameters<typeof projectHash>[0]['files'] = [];
  for (const f of model.list()) {
    if (f.kind === 'text') files.push({ id: f.id, path: f.path, kind: 'text', text: (await model.openText(f.id)).toString() });
    else files.push({ id: f.id, path: f.path, kind: f.kind, ...(f.hash ? { hash: f.hash } : {}) });
  }
  return projectHash({ files: files.filter((f) => f.kind !== 'binary' || f.hash), settings: projectSettings(model), seq: model.changeSeq });
}

const MAX_LOG = 40_000;

/** Runs on whichever device is currently elected: compiles on edits and publishes results. */
export class CompileLeader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstAt = 0;
  private running = false;
  private rerun = false;
  private seq = 0;
  lastResult: CompileResult | null = null;
  compiles = 0;
  private leaderSince = 0;
  private resultCbs = new Set<(r: CompileResult) => void>();
  private lastRequestAt = new Map<string, number>();
  /** The last run that could not start for lack of content (cleared by the next one that could). */
  lastIncomplete: CompileResult | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private unsubs: Array<() => void> = [];
  private aborts = new Set<AbortController>();

  constructor(
    private o: {
      mesh: Mesh;
      model: ProjectModel;
      blobs: BlobManager;
      election: Election;
      engine: CompileEngine;
      self: { dev: string; uname: string };
      debounceMs?: number;
      maxWaitMs?: number;
      timeoutMs?: number;
      /** A newly elected leader waits this long before its first build, so a device that only briefly thought it was best (election still converging) never compiles. */
      settleMs?: number;
      /** Minimum time between honored recompile requests from the same peer. */
      requestThrottleMs?: number;
      /** How long to wait for missing project content before reporting it unavailable (default 8 s). */
      acquireTimeoutMs?: number;
      /** Per image (default 8 s). */
      assetTimeoutMs?: number;
      /** A build that lacked content is attempted again after this long (default 5 s). */
      retryMs?: number;
    },
  ) {
    this.unsubs.push(o.model.onDocUpdate(() => this.schedule()));
    this.unsubs.push(o.mesh.onApp('compile-request', (from) => {
      if (!this.o.election.isLeader()) return;
      // Any member (viewers included) may ask, so a flood must not keep the leader busy: one request per peer per window.
      const now = Date.now();
      if (now - (this.lastRequestAt.get(from.deviceId) ?? 0) < (this.o.requestThrottleMs ?? 5000)) return;
      this.lastRequestAt.set(from.deviceId, now);
      void this.run().then((r) => {
        // Unchanged project: nothing was rebuilt, so make sure the requester has the current result.
        if (!this.stopped && r && r === this.lastResult && this.lastResult.seq === r.seq) void o.mesh.sendApp(from.deviceId, 'compiled', r);
      });
    }));
    this.unsubs.push(o.mesh.onPeerJoin((p) => {
      if (this.lastResult && this.o.election.isLeader()) void o.mesh.sendApp(p.deviceId, 'compiled', this.lastResult);
    }));
    this.unsubs.push(o.election.onLeaderChange((l) => {
      // Compile for the new state after a normal debounce, by which time the election has settled.
      if (l === o.self.dev) {
        this.leaderSince = Date.now();
        if (this.lastResult) o.mesh.broadcastApp('compiled', this.lastResult);
        this.schedule();
      } else this.leaderSince = 0;
    }));
  }

  onResult(cb: (r: CompileResult) => void) {
    this.resultCbs.add(cb);
    return () => void this.resultCbs.delete(cb);
  }

  stop() {
    this.stopped = true;
    this.rerun = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = this.retryTimer = null;
    for (const abort of this.aborts) abort.abort();
    for (const off of this.unsubs.splice(0)) off();
    this.resultCbs.clear();
  }

  private schedule(immediate = false) {
    if (this.stopped || !this.o.election.isLeader()) return;
    const now = Date.now();
    if (!this.timer) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    const settle = Math.max(0, this.leaderSince + (this.o.settleMs ?? 1500) - now);
    const wait = Math.max(settle, immediate ? 0 : Math.min(this.o.debounceMs ?? 1200, Math.max(0, this.firstAt + (this.o.maxWaitMs ?? 5000) - now)));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, wait);
  }

  /**
   * The complete, immutable input of one build: text and settings are fixed in one step, images are fetched by the
   * hashes captured then, and the identity is computed from exactly those bytes and settings. Throws
   * `IncompleteInputError` instead of building without content the project lists.
   */
  async snapshot(): Promise<CompileInput> {
    const { model, mesh, blobs } = this.o;
    const got = await acquireProject(mesh, model, blobs, { timeoutMs: this.o.acquireTimeoutMs ?? 8000, assetTimeoutMs: this.o.assetTimeoutMs ?? 8000 });
    if (!got.complete) throw new IncompleteInputError(got.missing);
    const files: CompileInput['files'] = [];
    for (const f of got.capture.files) {
      if (f.kind === 'text') files.push({ path: f.path, kind: 'text', text: f.text ?? '' });
      else if (f.kind === 'binary') files.push({ path: f.path, kind: 'binary', bytes: got.assets.get(f.hash ?? '') as Uint8Array });
    }
    return { files, main: got.capture.settings.main, engine: got.capture.settings.engine as TexEngine, stateHash: await projectHash(got.capture) };
  }

  /** The outcome for a build that could not start: nothing was compiled, and no earlier result is replaced or reused. */
  private incompleteResult(e: IncompleteInputError): CompileResult {
    return {
      stateHash: '',
      ok: false,
      diagnostics: [],
      log: `! Compile not started: ${e.message.replace('Cannot build yet: ', '')}\n`,
      incomplete: e.missing.map((m) => m.path),
      by: this.o.self,
      at: Date.now(),
      seq: ++this.seq,
    };
  }

  /** Compiles on this device regardless of leadership; the result is returned, never distributed. */
  async compileLocally(): Promise<{ result: CompileResult; pdf?: Uint8Array; synctex?: Uint8Array }> {
    if (this.stopped) throw new Error('Editor detached');
    const abort = new AbortController();
    this.aborts.add(abort);
    try {
    const input = await this.snapshot();
    if (this.stopped) throw new Error('Editor detached');
    if (!this.o.engine.supports.includes(input.engine)) {
      throw new Error(`This device cannot run ${input.engine}`);
    }
    const out = await this.o.engine.compile(input, { timeoutMs: this.o.timeoutMs ?? 120_000, signal: abort.signal });
    if (this.stopped) throw new Error('Editor detached');
    const result: CompileResult = {
      stateHash: input.stateHash,
      ok: out.ok && !!out.pdf,
      diagnostics: parseLog(out.log, input.main),
      log: out.log.slice(-MAX_LOG),
      by: this.o.self,
      at: Date.now(),
      seq: 0,
    };
    return { result, ...(out.pdf ? { pdf: out.pdf } : {}), ...(out.synctex ? { synctex: out.synctex } : {}) };
    } finally { this.aborts.delete(abort); }
  }

  /** Compiles now. A request while one is running queues exactly one follow-up run. */
  async run(): Promise<CompileResult | null> {
    if (this.stopped) return null;
    if (this.running) {
      this.rerun = true;
      return null;
    }
    if (!this.o.election.isLeader()) return null;
    const settle = this.leaderSince + (this.o.settleMs ?? 1500) - Date.now();
    if (settle > 0) {
      this.schedule();
      return null;
    }
    this.running = true;
    const abort = new AbortController();
    this.aborts.add(abort);
    let result: CompileResult | null = null;
    try {
      let input: CompileInput;
      try {
        input = await this.snapshot();
      } catch (e) {
        if (this.stopped) return null;
        if (!(e instanceof IncompleteInputError)) throw e;
        // Say so once per set of missing files, and look again later: images arriving raise no document update.
        const r = this.incompleteResult(e);
        if (this.lastIncomplete?.incomplete?.join('\0') !== r.incomplete?.join('\0')) {
          this.lastIncomplete = r;
          this.o.mesh.broadcastApp('compiled', r);
          for (const cb of this.resultCbs) cb(r);
        }
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.schedule();
        }, this.o.retryMs ?? 5000);
        (this.retryTimer as { unref?: () => void }).unref?.();
        return r;
      }
      this.lastIncomplete = null;
      if (this.stopped || !this.o.election.isLeader()) return null;
      if (this.lastResult?.stateHash === input.stateHash && this.lastResult.ok) return this.lastResult;
      let out: CompileOutput;
      try {
        out = await this.o.engine.compile(input, { timeoutMs: this.o.timeoutMs ?? 120_000, signal: abort.signal });
      } catch (e) {
        out = { ok: false, log: `! Compile failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (this.stopped || !this.o.election.isLeader()) return null;
      this.compiles++;
      const diagnostics = parseLog(out.log, input.main);
      result = {
        stateHash: input.stateHash,
        ok: out.ok && !!out.pdf,
        diagnostics,
        log: out.log.slice(-MAX_LOG),
        by: this.o.self,
        at: Date.now(),
        seq: ++this.seq,
      };
      if (out.pdf) result.pdfHash = await this.o.blobs.add(out.pdf);
      if (this.stopped || !this.o.election.isLeader()) return null;
      if (out.synctex) result.synctexHash = await this.o.blobs.add(out.synctex);
      if (this.stopped || !this.o.election.isLeader()) return null;
      this.lastResult = result;
      this.o.mesh.broadcastApp('compiled', result);
      for (const cb of this.resultCbs) cb(result);
    } finally {
      this.aborts.delete(abort);
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        this.schedule(true);
      }
    }
    return result;
  }
}

/** Runs on every device: receives results and exposes the latest (and last good) PDF. */
export class CompileClient {
  latest: CompileResult | null = null;
  lastGood: { result: CompileResult; pdf: Uint8Array; synctex?: Uint8Array } | null = null;
  private cbs = new Set<() => void>();
  private stopped = false;
  private unsubs: Array<() => void> = [];

  constructor(
    private o: { mesh: Mesh; model: ProjectModel; blobs: BlobManager; election?: Election; leader?: CompileLeader },
  ) {
    this.unsubs.push(o.mesh.onApp('compiled', (from, body) => void this.onResult(from, body as CompileResult), { editorOnly: true }));
    const electionOff = o.election?.onLeaderChange((l) => {
      const held = l ? this.pending.get(l) : undefined;
      if (held && l) {
        this.pending.delete(l);
        // The sender may have been demoted or have left while its result waited for our election view to agree.
        const sender = this.o.mesh.peers.find((p) => p.deviceId === l);
        if (sender && sender.claims.role !== 'viewer') void this.accept(held);
      }
    });
    if (electionOff) this.unsubs.push(electionOff);
    // Results produced on this very device are delivered locally (the mesh only reaches other peers).
    const leaderOff = o.leader?.onResult((r) => void this.accept(r));
    if (leaderOff) this.unsubs.push(leaderOff);
  }

  stop() {
    this.stopped = true;
    for (const off of this.unsubs.splice(0)) off();
    this.pending.clear();
    this.cbs.clear();
  }

  onChange(cb: () => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  private async onResult(from: PeerInfo, r: CompileResult) {
    // Only editors/owners may publish results, and only the elected leader if we know it.
    if (from.claims.role === 'viewer') return;
    if (r.by.dev !== from.deviceId) return;
    const lead = this.o.election?.leader();
    if (lead && lead !== from.deviceId) {
      // Possibly the new leader announcing before our own election view caught up: keep it for when we agree.
      this.pending.set(from.deviceId, r);
      return;
    }
    if (this.latest && this.latest.seq > r.seq && this.latest.by.dev === r.by.dev) return;
    await this.accept(r);
  }

  private pending = new Map<string, CompileResult>();

  private async accept(r: CompileResult) {
    if (this.stopped) return;
    this.latest = r;
    this.emit();
    if (r.ok && r.pdfHash) {
      try {
        const pdf = await this.o.blobs.fetch(r.pdfHash, 20_000);
        const synctex = r.synctexHash ? await this.o.blobs.fetch(r.synctexHash, 20_000).catch(() => undefined) : undefined;
        if (!this.stopped && this.latest === r) {
          this.lastGood = { result: r, pdf, ...(synctex ? { synctex } : {}) };
          this.emit();
        }
      } catch {
        /* keep the previous good PDF */
      }
    }
  }

  /** True when the project content differs from what the displayed PDF was built from. */
  async isStale(): Promise<boolean> {
    const shown = this.lastGood?.result.stateHash;
    if (!shown) return true;
    // The same capture and identity a build uses; a project that is not complete here cannot be said to match.
    const got = await acquireProject(this.o.mesh, this.o.model, this.o.blobs, { assets: false, timeoutMs: 3000 });
    return !got.complete || (await projectHash(got.capture)) !== shown;
  }

  /** Any member (including viewers) can ask the leader to recompile now. */
  requestCompile() {
    if (this.stopped) return;
    this.o.mesh.broadcastApp('compile-request', { at: Date.now() });
  }

  private emit() {
    for (const cb of this.cbs) cb();
  }
}
