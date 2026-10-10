import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';

export const latexLanguage = StreamLanguage.define(stex);

/** A bibliography entry; `detail` (the title) is what completion shows. */
export interface CiteEntry {
  key: string;
  detail?: string;
  author?: string;
  year?: string;
}

export interface ProjectIndex {
  labels: string[];
  cites: CiteEntry[];
  files: string[];
}

export const emptyIndex = (): ProjectIndex => ({ labels: [], cites: [], files: [] });

export function scanLabels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\\label\{([^}\s]+)\}/g)) out.push(m[1] as string);
  return out;
}

/** A BibTeX field's value, without the outer braces or quotes and with inner braces dropped. */
function bibField(body: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*(\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|"([^"]*)"|(\\d+))`, 'i').exec(body);
  const v = m?.[2] ?? m?.[3] ?? m?.[4];
  return v?.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() || undefined;
}

/** BibTeX/BibLaTeX entries: key, title (as detail), authors and year when present. */
export function scanBib(text: string): CiteEntry[] {
  const out: CiteEntry[] = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@|\s*$)/g;
  for (const m of text.matchAll(re)) {
    const type = (m[1] as string).toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const body = m[3] as string;
    const title = bibField(body, 'title');
    const author = bibField(body, 'author');
    const year = bibField(body, 'year') ?? bibField(body, 'date')?.slice(0, 4);
    out.push({ key: m[2] as string, ...(title ? { detail: title } : {}), ...(author ? { author } : {}), ...(year ? { year } : {}) });
  }
  return out;
}

export function buildIndex(files: Array<{ path: string; kind: string; text?: string }>): ProjectIndex {
  const labels = new Set<string>();
  const cites = new Map<string, CiteEntry>();
  const names: string[] = [];
  for (const f of files) {
    names.push(f.path);
    if (f.kind !== 'text' || f.text === undefined) continue;
    if (/\.bib$/i.test(f.path)) for (const c of scanBib(f.text)) cites.set(c.key, c);
    else for (const l of scanLabels(f.text)) labels.add(l);
    // \bibitem keys also count as citations
    for (const m of f.text.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) cites.set(m[1] as string, { key: m[1] as string });
  }
  return { labels: [...labels].sort(), cites: [...cites.values()].sort((a, b) => a.key.localeCompare(b.key)), files: names.sort() };
}

const COMMANDS = [
  'documentclass', 'usepackage', 'begin', 'end', 'section', 'subsection', 'subsubsection', 'paragraph', 'chapter', 'part',
  'label', 'ref', 'eqref', 'cite', 'citep', 'citet', 'footnote', 'textbf', 'textit', 'emph', 'texttt', 'textsc', 'underline',
  'includegraphics', 'caption', 'centering', 'input', 'include', 'bibliography', 'bibliographystyle', 'printbibliography',
  'title', 'author', 'date', 'maketitle', 'tableofcontents', 'newcommand', 'renewcommand', 'newpage', 'clearpage', 'item',
  'frac', 'sqrt', 'sum', 'int', 'left', 'right', 'mathbb', 'mathcal', 'mathbf', 'alpha', 'beta', 'gamma', 'delta', 'lambda',
  'url', 'href', 'hline', 'multicolumn', 'vspace', 'hspace', 'noindent', 'abstract',
];

const REF_RE = /\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref|vref)\{([^{}]*)$/;
const CITE_RE = /\\(?:cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$/;
const FILE_RE = /\\(?:input|include|includegraphics|bibliography|addbibresource)(?:\[[^\]]*\])?\{([^{}]*)$/;
const CMD_RE = /\\([a-zA-Z]*)$/;

/** Pure completion logic (testable without an editor). `before` is the text before the cursor. */
export function completeAt(before: string, index: ProjectIndex): { from: number; options: Completion[] } | null {
  const tail = (m: RegExpExecArray) => {
    const seg = m[1] as string;
    const cut = seg.lastIndexOf(',') + 1;
    return { from: before.length - (seg.length - cut), prefix: seg.slice(cut).trim() };
  };
  let m = REF_RE.exec(before);
  if (m) {
    const { from } = tail(m);
    return { from, options: index.labels.map((label) => ({ label, type: 'constant' })) };
  }
  m = CITE_RE.exec(before);
  if (m) {
    const { from } = tail(m);
    return { from, options: index.cites.map((c) => ({ label: c.key, type: 'text', ...(c.detail ? { detail: c.detail } : {}) })) };
  }
  m = FILE_RE.exec(before);
  if (m) {
    const { from } = tail(m);
    return { from, options: index.files.map((f) => ({ label: f.replace(/\.tex$/, ''), detail: f, type: 'file' })) };
  }
  m = CMD_RE.exec(before);
  if (m) return { from: before.length - (m[1] as string).length, options: COMMANDS.map((c) => ({ label: c, type: 'keyword' })) };
  return null;
}

export function latexCompletionSource(getIndex: () => ProjectIndex) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = ctx.state.sliceDoc(line.from, ctx.pos);
    const r = completeAt(before, getIndex());
    if (!r) return null;
    return { from: line.from + r.from, options: r.options, validFor: /^[\w:.\-/]*$/ };
  };
}
