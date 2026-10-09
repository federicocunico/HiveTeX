import { describe, expect, it } from 'vitest';
import { type SystemProbe, SystemMonitor } from '../src/index.js';

function setup(initial: Partial<SystemProbe> = {}) {
  const rec = { power: 'mains' as 'mains' | 'battery', batteryPct: 100, load: 0, ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const sink = {
    get selfRecord() {
      return rec;
    },
    update(patch: Partial<typeof rec>) {
      updates.push(patch);
      Object.assign(rec, patch);
    },
  };
  let probe: SystemProbe = { power: 'mains', batteryPct: 100, load: 0 };
  const mon = new SystemMonitor(sink, async () => probe);
  return { mon, updates, set: (p: Partial<SystemProbe>) => (probe = { ...probe, ...p }) };
}

describe('system monitor with mocked battery states (9.4)', () => {
  it('publishes when the laptop is unplugged, with its charge', async () => {
    const { mon, updates, set } = setup();
    await mon.tick();
    expect(updates).toHaveLength(0);
    set({ power: 'battery', batteryPct: 83 });
    await mon.tick();
    expect(updates).toEqual([{ power: 'battery', batteryPct: 83 }]);
  });

  it('publishes again when plugged back in', async () => {
    const { mon, updates, set } = setup({ power: 'battery', batteryPct: 40 });
    set({ power: 'mains', batteryPct: 41 });
    await mon.tick();
    expect(updates).toEqual([{ power: 'mains', batteryPct: 41 }]);
  });

  it('ignores small battery drift but reports the 50 % crossing and 5-point moves', async () => {
    const { mon, updates, set } = setup({ power: 'battery', batteryPct: 56 });
    set({ power: 'battery', batteryPct: 54 });
    await mon.tick();
    expect(updates).toHaveLength(0);
    set({ batteryPct: 49 });
    await mon.tick();
    expect(updates).toEqual([{ batteryPct: 49 }]); // crossed below 50
    set({ batteryPct: 43 });
    await mon.tick();
    expect(updates).toHaveLength(2); // >= 5 points
  });

  it('smooths CPU load and only reports sustained changes', async () => {
    const { mon, updates, set } = setup();
    set({ load: 0.9 });
    await mon.tick(); // first sample seeds the average at 0.9 -> change >= 0.15
    expect(updates[0]?.load).toBeCloseTo(0.9);
    set({ load: 0.1 });
    await mon.tick(); // smoothed 0.5
    expect(updates.at(-1)?.load).toBeCloseTo(0.5);
    set({ load: 0.1 });
    await mon.tick(); // smoothed 0.3
    expect(updates.at(-1)?.load).toBeCloseTo(0.3);
  });

  it('keeps going when the probe fails', async () => {
    const rec = { power: 'mains' as const, batteryPct: 100, load: 0 };
    const mon = new SystemMonitor({ selfRecord: rec, update() { throw new Error('should not be called'); } }, async () => { throw new Error('no access'); });
    await expect(mon.tick()).resolves.toBeUndefined();
  });
});
