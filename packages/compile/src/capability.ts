export type EngineKind = 'native' | 'wasm' | 'none';
export type TexEngine = 'pdflatex' | 'xelatex' | 'lualatex';

/** What a device advertises about its ability to compile for the others. */
export interface CapabilityRecord {
  dev: string;
  uname: string;
  engine: EngineKind;
  /** TeX engines this device can actually run. */
  supports: TexEngine[];
  /** Benchmark relative to a reference machine (1.0 = reference). */
  perf: number;
  power: 'mains' | 'battery';
  batteryPct: number;
  /** 0..1 current CPU load. */
  load: number;
  /** User disabled "compile for others". */
  optOut: boolean;
  /** Lamport-style stamp: higher replaces lower for the same device. */
  stamp: number;
}

export const ENGINE_BASE: Record<EngineKind, number> = { native: 100, wasm: 25, none: 0 };

export function powerFactor(r: Pick<CapabilityRecord, 'power' | 'batteryPct'>): number {
  if (r.power === 'mains') return 1;
  return r.batteryPct > 50 ? 0.5 : 0.2;
}

export function score(r: CapabilityRecord, projectEngine: TexEngine): number {
  if (r.optOut || r.engine === 'none') return 0;
  if (!r.supports.includes(projectEngine)) return 0;
  const load = Math.min(Math.max(r.load, 0), 0.95);
  return ENGINE_BASE[r.engine] * Math.min(Math.max(r.perf, 0.1), 8) * powerFactor(r) * (1 - load);
}

/** CPU micro-benchmark normalised so that ~1.0 is a typical modern laptop. */
export function measurePerformance(budgetMs = 60): number {
  const start = Date.now();
  let iters = 0;
  let x = 0x12345678;
  while (Date.now() - start < budgetMs) {
    for (let i = 0; i < 20000; i++) {
      x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + i) | 0;
    }
    iters++;
  }
  const perMs = (iters * 20000) / (Date.now() - start);
  return Math.min(Math.max(perMs / 400_000, 0.1), 8);
}
