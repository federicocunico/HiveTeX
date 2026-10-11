/**
 * Projects this device created a moment ago. Their file table is authored here, so it is complete from the start; a
 * project that is only joined has an unknown file table until a peer confirms it (see ProjectModel.markComplete).
 */
const created = new Set<string>();

export function markCreatedHere(projectId: string) {
  created.add(projectId);
}

export function takeCreatedHere(projectId: string): boolean {
  return created.delete(projectId);
}
