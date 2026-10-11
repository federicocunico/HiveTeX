import type { ProjectModel } from '@hivetex/sync';
import { strToU8, zipSync } from 'fflate';

export interface RecoveryExport {
  zip: Uint8Array;
  /** Files whose content could not be read (not in memory and storage is failing, or a binary not on this device). */
  missing: string[];
}

/**
 * A zip of the project as this device holds it right now, for when local storage keeps failing. It reads what is
 * in memory first, so edits that were never stored are included, and never stops at the first unreadable file.
 * `getBlob` supplies binary content (it may fail for files this device does not have).
 */
export async function exportRecoveryZip(model: ProjectModel, getBlob: (hash: string) => Promise<Uint8Array>): Promise<RecoveryExport> {
  const files: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  for (const f of model.list()) {
    try {
      if (f.kind === 'text') files[f.path] = strToU8((await model.openText(f.id)).toString());
      else if (f.kind === 'binary' && f.hash) files[f.path] = await getBlob(f.hash);
    } catch {
      missing.push(f.path);
    }
  }
  if (missing.length) files['RECOVERY-MISSING.txt'] = strToU8(`These files could not be read when this copy was made:\n${missing.join('\n')}\n`);
  return { zip: zipSync(files, { level: 6 }), missing };
}
