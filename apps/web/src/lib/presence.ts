/** Number of presence colors (`--p1` … `--p8` in tokens.css). */
export const PRESENCE_SLOTS = 8;

/** A person's presence color slot (1-based), derived from their username so it is the same everywhere. */
export function presenceSlot(username: string): number {
  let h = 0;
  for (const c of username.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % PRESENCE_SLOTS) + 1;
}

/** The presence colors as plain values (same as --p1…--p8 in tokens.css, identical in both themes). */
export const PRESENCE_COLORS = ['#2f6feb', '#c2417a', '#0b7a70', '#7a4fd6', '#c2410c', '#3e7d2a', '#a16207', '#0e7490'] as const;

/** A person's color as a value, for places that cannot use CSS variables (remote cursors drawn by the editor). */
export function presenceColor(username: string): string {
  return PRESENCE_COLORS[presenceSlot(username) - 1] as string;
}

export type PresentPerson = { clientId: number; name: string; color: string; file: string | null };

/**
 * Co-authors from the shared presence (awareness) states, without this client. Older clients do not share their
 * open file: it is then unknown (null), not an error.
 */
export function peopleFromAwareness(states: Map<number, unknown>, me: number): PresentPerson[] {
  const out: PresentPerson[] = [];
  for (const [id, st] of states) {
    if ((st as { seed?: unknown } | null)?.seed === true) continue;
    const user = (st as { user?: { name?: unknown } } | null)?.user;
    if (id === me || typeof user?.name !== 'string') continue;
    const file = (st as { file?: unknown }).file;
    out.push({ clientId: id, name: user.name, color: presenceColor(user.name), file: typeof file === 'string' ? file : null });
  }
  return out;
}

/** CSS color for a slot. */
export function presenceVar(slot: number): string {
  return `var(--p${slot})`;
}

/** Up to two initials: "ada_lindqvist" → "AL", "kenji" → "KE". */
export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
