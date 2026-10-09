import type { CapabilityRecord } from './capability.js';

export interface SystemProbe {
  power: 'mains' | 'battery';
  batteryPct: number;
  /** 0..1 */
  load: number;
}

export interface CapabilitySink {
  update(patch: Partial<Pick<CapabilityRecord, 'power' | 'batteryPct' | 'load'>>): void;
  readonly selfRecord: Pick<CapabilityRecord, 'power' | 'batteryPct' | 'load'>;
}

/**
 * Polls the machine (battery, CPU load) and publishes capability changes only when they matter, so the
 * mesh is not flooded: power-state flips and crossing the 50 % battery line always publish, otherwise a
 * battery change of >= 5 points or a smoothed load change of >= 0.15.
 */
export class SystemMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private smoothed: number | null = null;

  constructor(
    private sink: CapabilitySink,
    private probe: () => Promise<SystemProbe>,
    private intervalMs = 5000,
  ) {}

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    let p: SystemProbe;
    try {
      p = await this.probe();
    } catch {
      return; // keep the last known values
    }
    this.smoothed = this.smoothed === null ? p.load : this.smoothed * 0.5 + p.load * 0.5;
    const cur = this.sink.selfRecord;
    const patch: Partial<Pick<CapabilityRecord, 'power' | 'batteryPct' | 'load'>> = {};
    if (p.power !== cur.power) patch.power = p.power;
    const crossed = (cur.batteryPct > 50) !== (p.batteryPct > 50);
    if (p.power === 'battery' && (crossed || Math.abs(p.batteryPct - cur.batteryPct) >= 5)) patch.batteryPct = p.batteryPct;
    else if (p.power !== cur.power) patch.batteryPct = p.batteryPct;
    if (Math.abs(this.smoothed - cur.load) >= 0.15) patch.load = Math.round(this.smoothed * 100) / 100;
    if (Object.keys(patch).length) this.sink.update(patch);
  }
}
