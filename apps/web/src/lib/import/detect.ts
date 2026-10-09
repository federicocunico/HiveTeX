export type Engine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface TextSource {
  path: string;
  text: string;
}

export interface MainDetection {
  /** Best guess for the root document, or null if there is no `.tex` file at all. */
  main: string | null;
  /** Files that look like complete documents (`\documentclass` + `\begin{document}`), for the picker. */
  candidates: string[];
  /** True when the guess is not clear-cut and the user should confirm it. */
  ambiguous: boolean;
}

/** Removes LaTeX comments (an unescaped `%` to end of line). */
export function stripComments(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');
}

const MAGIC = (key: string) => new RegExp(`^\\s*%\\s*!\\s*T[Ee]X\\s+(?:TS-)?${key}\\s*=\\s*(.+?)\\s*$`, 'im');

function isRootDocument(text: string): boolean {
  const t = stripComments(text);
  return /\\documentclass\s*(\[[^\]]*\])?\s*\{/.test(t) && /\\begin\s*\{document\}/.test(t);
}

function resolve(fromPath: string, rel: string): string {
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Picks the main file in this order: a `% !TEX root` target, `main.tex`, a top-level complete document, any complete
 * document; falling back to the first `.tex` file (flagged ambiguous).
 */
export function detectMain(files: TextSource[]): MainDetection {
  const tex = files.filter((f) => /\.tex$/i.test(f.path));
  const paths = new Set(tex.map((f) => f.path));
  const candidates = tex.filter((f) => isRootDocument(f.text)).map((f) => f.path).sort();
  const result = (main: string | null, ambiguous: boolean): MainDetection => ({ main, candidates, ambiguous });
  if (tex.length === 0) return result(null, false);

  const roots = new Set<string>();
  for (const f of tex) {
    const m = MAGIC('root').exec(f.text);
    if (m) {
      const target = resolve(f.path, m[1] as string);
      if (paths.has(target)) roots.add(target);
    }
  }
  if (roots.size === 1) return result([...roots][0] as string, false);
  if (paths.has('main.tex')) return result('main.tex', false);
  const top = candidates.filter((p) => !p.includes('/'));
  if (top.length > 0) return result(top[0] as string, top.length > 1);
  if (candidates.length > 0) return result(candidates[0] as string, candidates.length > 1);
  const fallback = tex.map((f) => f.path).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return result(fallback[0] as string, true);
}

/** Engine from a `% !TEX program` magic comment, or XeLaTeX for documents that need a Unicode engine. */
export function detectEngine(mainText: string): Engine | null {
  const m = MAGIC('program').exec(mainText);
  if (m) {
    const p = (m[1] as string).toLowerCase();
    if (p.startsWith('xe')) return 'xelatex';
    if (p.startsWith('lua')) return 'lualatex';
    if (p.includes('latex') || p.includes('tex')) return 'pdflatex';
  }
  const t = stripComments(mainText);
  for (const u of t.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    const pkgs = (u[1] as string).split(',').map((s) => s.trim());
    if (pkgs.some((p) => p === 'fontspec' || p === 'unicode-math' || p === 'polyglossia')) return 'xelatex';
  }
  return null;
}
