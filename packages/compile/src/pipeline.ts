import type { BlobManager, Mesh, PeerInfo, ProjectModel } from '@hivetex/sync';
import { sha256Hex } from '@hivetex/sync';
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
  by: { dev: string; uname: string };
  at: number;
  seq: number;
}

export const settings = {
  main: (m: ProjectModel) => String(m.settings.get('main') ?? 'main.tex'),
  engine: (m: ProjectModel) => String(m.settings.get('engine') ?? 'pdflatex') as TexEngine,
};

/** Hash of the project's content (paths + file contents), independent of CRDT internals. */
export async function computeStateHash(model: ProjectModel): Promise<string> {
  const parts: string[] = [];
  for (const f of model.list()) {
    let h = '';
    if (f.kind === 'text') h = await sha256Hex(new TextEncoder().encode((await model.openText(f.id)).toString()));
    else if (f.kind === 'binary') h = f.hash ?? '';
    parts.push(`${f.kind}\0${f.path}\0${h}`);
  }
  parts.sort();
  return sha256Hex(new TextEncoder().encode(parts.join('\n')));
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
    },
  ) {
    o.model.onDocUpdate(() => this.schedule());
    o.mesh.onApp('compile-request', (from) => {
      if (!this.o.election.isLeader()) return;
      // Any member (viewers included) may ask, so a flood must not keep the leader busy: one request per peer per window.
      const now = Date.now();
      if (now - (this.lastRequestAt.get(from.deviceId) ?? 0) < (this.o.requestThrottleMs ?? 5000)) return;
      this.lastRequestAt.set(from.deviceId, now);
      void this.run().then((r) => {
        // Unchanged project: nothing was rebuilt, so make sure the requester has the current result.
        if (r && r === this.lastResult && this.lastResult.seq === r.seq) void o.mesh.sendApp(from.deviceId, 'compiled', r);
      });
    });
    o.mesh.onPeerJoin((p) => {
      if (this.lastResult && this.o.election.isLeader()) void o.mesh.sendApp(p.deviceId, 'compiled', this.lastResult);
    });
    o.election.onLeaderChange((l) => {
      // Compile for the new state after a normal debounce, by which time the election has settled.
      if (l === o.self.dev) {
        this.leaderSince = Date.now();
        if (this.lastResult) o.mesh.broadcastApp('compiled', this.lastResult);
        this.schedule();
      } else this.leaderSince = 0;
    });
  }

  onResult(cb: (r: CompileResult) => void) {
    this.resultCbs.add(cb);
  }

  private schedule(immediate = false) {
    if (!this.o.election.isLeader()) return;
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

  async snapshot(): Promise<CompileInput> {
    const { model, mesh, blobs } = this.o;
    await mesh.prefetchAll();
    const files: CompileInput['files'] = [];
    for (const f of model.list()) {
      if (f.kind === 'text') files.push({ path: f.path, kind: 'text', text: (await model.openText(f.id)).toString() });
      else if (f.kind === 'binary' && f.hash) {
        try {
          files.push({ path: f.path, kind: 'binary', bytes: await blobs.fetch(f.hash, 8000) });
        } catch {
          /* missing image: the engine will report it */
        }
      }
    }
    return { files, main: settings.main(model), engine: settings.engine(model), stateHash: await computeStateHash(model) };
  }

  /** Compiles on this device regardless of leadership; the result is returned, never distributed. */
  async compileLocally(): Promise<{ result: CompileResult; pdf?: Uint8Array; synctex?: Uint8Array }> {
    const input = await this.snapshot();
    if (!this.o.engine.supports.includes(input.engine)) {
      throw new Error(`This device cannot run ${input.engine}`);
    }
    const out = await this.o.engine.compile(input, { timeoutMs: this.o.timeoutMs ?? 120_000 });
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
  }

  /** Compiles now. A request while one is running queues exactly one follow-up run. */
  async run(): Promise<CompileResult | null> {
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
    let result: CompileResult | null = null;
    try {
      const input = await this.snapshot();
      if (this.lastResult?.stateHash === input.stateHash && this.lastResult.ok) return this.lastResult;
      let out: CompileOutput;
      try {
        out = await this.o.engine.compile(input, { timeoutMs: this.o.timeoutMs ?? 120_000 });
      } catch (e) {
        out = { ok: false, log: `! Compile failed: ${e instanceof Error ? e.message : String(e)}` };
      }
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
      if (out.synctex) result.synctexHash = await this.o.blobs.add(out.synctex);
      this.lastResult = result;
      this.o.mesh.broadcastApp('compiled', result);
      for (const cb of this.resultCbs) cb(result);
    } finally {
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

  constructor(
    private o: { mesh: Mesh; model: ProjectModel; blobs: BlobManager; election?: Election; leader?: CompileLeader },
  ) {
    o.mesh.onApp('compiled', (from, body) => void this.onResult(from, body as CompileResult));
    o.election?.onLeaderChange((l) => {
      const r = l ? this.pending.get(l) : undefined;
      if (r && l) {
        this.pending.delete(l);
        void this.accept(r);
      }
    });
    // Results produced on this very device are delivered locally (the mesh only reaches other peers).
    o.leader?.onResult((r) => void this.accept(r));
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
    this.latest = r;
    this.emit();
    if (r.ok && r.pdfHash) {
      try {
        const pdf = await this.o.blobs.fetch(r.pdfHash, 20_000);
        const synctex = r.synctexHash ? await this.o.blobs.fetch(r.synctexHash, 20_000).catch(() => undefined) : undefined;
        if (this.latest === r) {
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
    await this.o.mesh.prefetchAll();
    return (await computeStateHash(this.o.model)) !== shown;
  }

  /** Any member (including viewers) can ask the leader to recompile now. */
  requestCompile() {
    this.o.mesh.broadcastApp('compile-request', { at: Date.now() });
  }

  private emit() {
    for (const cb of this.cbs) cb();
  }
}
