/**
 * Projects this device created a moment ago. Their file table is authored here, so it is complete from the start; a
 * project that is only joined has an unknown file table until a peer confirms it (see ProjectModel.markComplete).
 */
const created = new Set<string>();

export function markCreatedHere(projectId: string) {
  created.add(projectId);
  // Keep creation evidence until the authoritative store can initialize, even across a page/worker restart.
  try { localStorage.setItem(`hivetex.createdHere.${projectId}`, '1'); } catch { /* the live signal still works */ }
}

export function takeCreatedHere(projectId: string): boolean {
  const live = created.delete(projectId);
  try { return localStorage.getItem(`hivetex.createdHere.${projectId}`) === '1' || live; } catch { return live; }
}

/** The authoritative store now holds the proof; a deleted store must not inherit a stale creation signal. */
export function acknowledgeCreatedHere(projectId: string) {
  created.delete(projectId);
  try { localStorage.removeItem(`hivetex.createdHere.${projectId}`); } catch { /* store evidence is already durable */ }
}
