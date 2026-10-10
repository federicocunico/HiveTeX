/**
 * The document outline: sectioning commands in reading order, starting at the main file and following \input and
 * \include. Comments are skipped. Numbers follow LaTeX for unstarred headings ("2.1").
 */
export const LEVELS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'] as const;

export interface OutlineEntry {
  /** 0 = part … 6 = subparagraph */
  level: number;
  title: string;
  /** "2.1", or '' for starred headings and paragraphs. */
  number: string;
  file: string;
  /** 1-based line of the heading in `file`. */
  line: number;
}

const CMD = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{|\\(input|include|subfile)\s*\{([^}]*)\}/g;

/** The text of a balanced {…} group starting just after its opening brace. */
function group(text: string, from: number): string {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(from, i);
  }
  return text.slice(from, from + 120);
}

/** A heading title for display: drops commands like \label{…}, keeps their arguments' text. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\\(label|index|footnote)\{[^}]*\}/g, '')
    .replace(/\\[a-zA-Z]+\*?\s*(\[[^\]]*\])?/g, '')
    .replace(/[{}~]/g, (c) => (c === '~' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Blanks out comments (keeping offsets), so headings inside them are ignored. */
function stripComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
}

function resolve(name: string, exists: (p: string) => boolean): string | null {
  const n = name.trim().replace(/^\.\//, '');
  if (exists(n)) return n;
  if (exists(`${n}.tex`)) return `${n}.tex`;
  return null;
}

export function buildOutline(main: string, read: (path: string) => string | undefined, allTexFiles: string[] = []): OutlineEntry[] {
  const out: Array<Omit<OutlineEntry, 'number'> & { starred?: boolean }> = [];
  const seen = new Set<string>();
  const exists = (p: string) => read(p) !== undefined;

  const walk = (file: string, depth: number) => {
    if (seen.has(file) || depth > 20) return;
    seen.add(file);
    const raw = read(file);
    if (raw === undefined) return;
    const text = stripComments(raw);
    const lineAt = (i: number) => text.slice(0, i).split('\n').length;
    for (const m of text.matchAll(CMD)) {
      const at = m.index ?? 0;
      if (m[1]) {
        const level = LEVELS.indexOf(m[1] as (typeof LEVELS)[number]);
        const title = cleanTitle(group(text, at + m[0].length));
        out.push({ level, title: title || '(untitled)', file, line: lineAt(at), ...(m[2] ? { starred: true } : {}) });
      } else if (m[3]) {
        const target = resolve(m[4] ?? '', exists);
        if (target) walk(target, depth + 1);
      }
    }
  };

  if (exists(main)) walk(main, 0);
  else for (const f of [...allTexFiles].sort()) walk(f, 0);
  return number(out);
}

/** Adds LaTeX-style numbers relative to the highest level present (chapters in a report, sections in an article). */
function number(entries: Array<Omit<OutlineEntry, 'number'> & { starred?: boolean }>): OutlineEntry[] {
  const top = Math.max(1, Math.min(...entries.map((e) => e.level), 6));
  const counters = [0, 0, 0, 0, 0, 0, 0];
  return entries.map(({ starred, ...e }) => {
    let n = '';
    // part is not counted into section numbers; paragraphs are not numbered
    if (!starred && e.level >= top && e.level <= 4) {
      counters[e.level] = (counters[e.level] ?? 0) + 1;
      for (let l = e.level + 1; l < counters.length; l++) counters[l] = 0;
      n = counters.slice(top, e.level + 1).join('.');
    }
    return { ...e, number: n };
  });
}

/** The heading that contains `line` in `file`: the last one before it in that file, if any. */
export function currentHeading(outline: OutlineEntry[], file: string, line: number): OutlineEntry | null {
  let cur: OutlineEntry | null = null;
  for (const e of outline) if (e.file === file && e.line <= line) cur = e;
  return cur;
}
