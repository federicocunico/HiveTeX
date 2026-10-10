import { describe, expect, it } from 'vitest';
import { initials, peopleFromAwareness, PRESENCE_COLORS, presenceColor, presenceSlot } from '../src/lib/presence.js';

describe('presence', () => {
  it('gives each account one stable color from the palette', () => {
    expect(presenceSlot('ada_l')).toBe(presenceSlot('ADA_L'));
    expect(presenceColor('ada_l')).toBe(PRESENCE_COLORS[presenceSlot('ada_l') - 1]);
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(presenceSlot)).size).toBeGreaterThan(3);
  });

  it('reads co-authors and their open file, tolerating clients that do not share one', () => {
    const states = new Map<number, unknown>([
      [1, { user: { name: 'me' }, file: 'main.tex' }],
      [2, { user: { name: 'ada', color: '#000' }, file: 'intro.tex' }],
      [3, { user: { name: 'old-client' } }],
      [4, { cursor: {} }],
    ]);
    expect(peopleFromAwareness(states, 1)).toEqual([
      { clientId: 2, name: 'ada', color: presenceColor('ada'), file: 'intro.tex' },
      { clientId: 3, name: 'old-client', color: presenceColor('old-client'), file: null },
    ]);
  });

  it('makes initials', () => {
    expect(initials('ada_lindqvist')).toBe('AL');
    expect(initials('kenji')).toBe('KE');
  });
});
