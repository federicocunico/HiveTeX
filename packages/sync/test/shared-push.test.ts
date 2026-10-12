import { expect, it } from 'vitest';
import { SharedPushChannels } from '../src/shared-push.js';
import type { PushChannel, PushState } from '../src/doorbell.js';

it('multiplexes foreground/dormant topics and ignores callbacks from a replaced stream', async () => {
  const streams = new Set<object>();
  const old: Array<(t: string, d: string) => void> = [];
  const received: string[] = [];
  let max = 0;
  const physical: PushChannel = {
    subscribe(topics, cb, state) {
      const stream = { topics }; streams.add(stream); max = Math.max(max, streams.size); old.push(cb);
      state('subscribed'); return () => { streams.delete(stream); state('off'); };
    },
    publish: async () => {},
  };
  const shared = new SharedPushChannels(() => physical);
  const states: PushState[] = [];
  const a = shared.channel('https://push').subscribe(['a'], (_t, d) => received.push('a:' + d), (s) => states.push(s));
  const b = shared.channel('https://push/').subscribe(['b'], (_t, d) => received.push('b:' + d), () => {});
  await new Promise((r) => setTimeout(r, 10));
  expect(streams.size).toBe(1); expect(max).toBe(1);
  old[0]?.('a', 'first'); old[0]?.('b', 'first');
  expect(received).toEqual(['a:first', 'b:first']);
  a(); await new Promise((r) => setTimeout(r, 10));
  old[0]?.('b', 'obsolete'); old[1]?.('b', 'current');
  expect(received.at(-1)).toBe('b:current'); expect(received).not.toContain('b:obsolete');
  expect(states.at(-1)).toBe('off');
  shared.restart(); expect(streams.size).toBe(1); expect(max).toBe(1);
  b(); await new Promise((r) => setTimeout(r, 10)); expect(streams.size).toBe(0);
  shared.close();
});
