import { encodeValue, type IngressEntry, type ProjectModel } from '@hivetex/sync';
import { strToU8, zipSync } from 'fflate';
import * as Y from 'yjs';

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
export async function exportRecoveryZip(model: ProjectModel, getBlob: (hash: string) => Promise<Uint8Array>, getIngress?: () => Promise<IngressEntry[]>): Promise<RecoveryExport> {
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
  if (getIngress) {
    try {
      const entries = await getIngress();
      if (entries.length) {
        let dir = '.hivetex-recovery', n = 0;
        while (Object.keys(files).some((path) => path === dir || path.startsWith(dir + '/'))) dir = `.hivetex-recovery-${++n}`;
        const bases: Array<{ docId: string; file: string }> = [];
        for (const docId of new Set(entries.map((e) => e.docId))) {
          try {
            const file = `${dir}/bases/${bases.length}.yjs`;
            files[file] = Y.encodeStateAsUpdate(await model.getDoc(docId));
            bases.push({ docId, file });
          } catch { missing.push(`base snapshot for ${docId}`); }
        }
        files[`${dir}/ingress.json`] = strToU8(encodeValue({ version: 1, entries, bases }));
        files[`${dir}/README.txt`] = strToU8('Pending and denied edits retained on this device are included in ingress.json as lossless Yjs updates, with their original document bases in bases/. To recover locally, apply a base snapshot to a new Y.Doc, then the entries for its docId. They are recovery data, not part of the shared project. Denied edits must not be automatically published.\n');
      }
    } catch { missing.push('native pending edit journal'); }
  }
  if (missing.length) files['RECOVERY-MISSING.txt'] = strToU8(`These files could not be read when this copy was made:\n${missing.join('\n')}\n`);
  return { zip: zipSync(files, { level: 6 }), missing };
}
