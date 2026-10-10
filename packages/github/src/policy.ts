export interface BackupPolicy {
  enabled: boolean;
  /** Back up after this many minutes without edits (null = off). */
  idleMinutes: number | null;
  /** Back up after this many accepted changes (null = off). */
  everyChanges: number | null;
  /** Never back up more often than this. */
  minIntervalMinutes: number;
  includePdf: boolean;
}

export const DEFAULT_POLICY: BackupPolicy = {
  enabled: true,
  idleMinutes: 15,
  everyChanges: null,
  minIntervalMinutes: 5,
  includePdf: false,
};

export interface BackupMeta {
  changesSince: number;
  lastChangeAt: number;
  lastBackupAt: number;
  lastSha: string | null;
  lastError: string | null;
  contributors: string[];
  firstChangeAt: number;
}

export const emptyMeta = (): BackupMeta => ({
  changesSince: 0,
  lastChangeAt: 0,
  lastBackupAt: 0,
  lastSha: null,
  lastError: null,
  contributors: [],
  firstChangeAt: 0,
});

export type Decision = 'backup' | 'wait';

/** Pure scheduling rule so it can be tested without clocks or network. */
export function decide(policy: BackupPolicy, meta: BackupMeta, now: number, manual = false): Decision {
  if (manual) return meta.changesSince > 0 || meta.lastSha === null ? 'backup' : 'wait';
  if (!policy.enabled || meta.changesSince <= 0) return 'wait';
  if (now - meta.lastBackupAt < policy.minIntervalMinutes * 60_000) return 'wait';
  if (policy.everyChanges && meta.changesSince >= policy.everyChanges) return 'backup';
  if (policy.idleMinutes && now - meta.lastChangeAt >= policy.idleMinutes * 60_000) return 'backup';
  return 'wait';
}

export function commitMessage(meta: BackupMeta, now: number): string {
  const who = meta.contributors.length ? meta.contributors.join(', ') : 'unknown';
  const fmt = (t: number) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '?');
  return `hivetex backup: ${who} (${fmt(meta.firstChangeAt)} – ${fmt(Math.max(meta.lastChangeAt, now))} UTC)`;
}
