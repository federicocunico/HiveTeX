import { type ProjectModel, applyTextDiff } from '@p2platex/sync';

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface Match {
  fileId: string;
  path: string;
  line: number;
  col: number;
  length: number;
  preview: string;
}

function toRegex(query: string, o: SearchOptions): RegExp | null {
  if (!query) return null;
  let src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) src = `\\b${src}\\b`;
  try {
    return new RegExp(src, `g${o.caseSensitive ? '' : 'i'}m`);
  } catch {
    return null;
  }
}

/** Searches every text file of the project (loads their documents on demand). */
export async function searchProject(model: ProjectModel, query: string, o: SearchOptions = {}, limit = 500): Promise<Match[]> {
  const re = toRegex(query, o);
  if (!re) return [];
  const out: Match[] = [];
  for (const f of model.list()) {
    if (f.kind !== 'text') continue;
    const text = (await model.openText(f.id)).toString();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i] as string;
      re.lastIndex = 0;
      for (let m = re.exec(ln); m; m = re.exec(ln)) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        out.push({ fileId: f.id, path: f.path, line: i + 1, col: m.index, length: m[0].length, preview: ln.trim().slice(0, 160) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** Replaces in every text file as ordinary collaborative edits. Returns the number of replacements. */
export async function replaceProject(model: ProjectModel, query: string, replacement: string, o: SearchOptions = {}): Promise<number> {
  const re = toRegex(query, o);
  if (!re) return 0;
  let n = 0;
  for (const f of model.list()) {
    if (f.kind !== 'text') continue;
    const ytext = await model.openText(f.id);
    const before = ytext.toString();
    const after = before.replace(re, () => {
      n++;
      return replacement;
    });
    if (after !== before) applyTextDiff(ytext, after);
  }
  return n;
}
