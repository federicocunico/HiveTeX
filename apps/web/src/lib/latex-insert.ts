/**
 * Text produced by the formatting toolbar and the insert pickers. Pure functions: they return the text to insert and
 * where the cursor (or selection) should end up, relative to the start of the inserted text. The editor applies the
 * result as one ordinary edit, so it syncs, shows in Changes and undoes like typing.
 */
export interface Insertion {
  text: string;
  /** Selection after insertion, relative to the start of `text`. */
  anchor: number;
  head?: number;
}

/** Wraps `selected` in `before…after`; with no selection the cursor lands between them. */
export function wrap(selected: string, before: string, after: string): Insertion {
  const text = `${before}${selected}${after}`;
  return selected ? { text, anchor: before.length, head: before.length + selected.length } : { text, anchor: before.length };
}

export const SECTION_LEVELS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'] as const;
export type SectionLevel = (typeof SECTION_LEVELS)[number];

export function section(level: SectionLevel, selected: string): Insertion {
  return wrap(selected, `\\${level}{`, '}');
}

export const bold = (s: string) => wrap(s, '\\textbf{', '}');
export const italic = (s: string) => wrap(s, '\\textit{', '}');
export const inlineMath = (s: string) => wrap(s, '$', '$');

export function displayMath(selected: string): Insertion {
  return wrap(selected, '\\begin{equation}\n  ', '\n\\end{equation}');
}

/** A list; selected lines each become an item. */
export function list(kind: 'itemize' | 'enumerate', selected: string): Insertion {
  const lines = selected
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    const text = `\\begin{${kind}}\n  \\item \n\\end{${kind}}`;
    return { text, anchor: text.indexOf('\\item ') + 6 };
  }
  const text = `\\begin{${kind}}\n${lines.map((l) => `  \\item ${l}`).join('\n')}\n\\end{${kind}}`;
  return { text, anchor: text.length };
}

/** A label name from a file path: "figures/Contact Map.png" → "contact-map". */
export function labelFrom(path: string): string {
  const base = path.split('/').pop() ?? path;
  return (
    base
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'figure'
  );
}

/** A figure environment for a project image; the cursor lands in the caption. */
export function figure(path: string): Insertion {
  const target = path.replace(/\.(pdf|png|jpe?g|eps)$/i, '');
  const text = `\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${target}}\n  \\caption{}\n  \\label{fig:${labelFrom(path)}}\n\\end{figure}`;
  return { text, anchor: text.indexOf('\\caption{') + 9 };
}

/** A table environment with a rows × cols tabular; the cursor lands in the first cell. */
export function table(rows: number, cols: number): Insertion {
  const r = Math.max(1, Math.min(50, Math.floor(rows)));
  const c = Math.max(1, Math.min(20, Math.floor(cols)));
  const row = Array.from({ length: c }, () => '').join(' & ');
  const body = Array.from({ length: r }, () => `    ${row} \\\\`).join('\n');
  const text = `\\begin{table}[t]\n  \\centering\n  \\begin{tabular}{${'l'.repeat(c)}}\n    \\hline\n${body}\n    \\hline\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}`;
  return { text, anchor: text.indexOf('\\hline\n') + 11 };
}

export const cite = (key: string): Insertion => ({ text: `\\cite{${key}}`, anchor: key.length + 7 });
export const ref = (label: string): Insertion => {
  // equations read better with \eqref
  const cmd = label.startsWith('eq:') ? 'eqref' : 'ref';
  const text = `\\${cmd}{${label}}`;
  return { text, anchor: text.length };
};

/** A symbol command; outside math it is wrapped in $…$. Commands with an argument put the cursor in its braces. */
export function symbol(command: string, inMath: boolean): Insertion {
  const text = inMath ? command : `$${command}$`;
  const brace = text.indexOf('{}');
  return { text, anchor: brace >= 0 ? brace + 1 : text.length };
}

/**
 * Whether `pos` in `doc` is inside math: counts unescaped $ before it on the paragraph, and open \( or \[ or
 * equation-like environments. Good enough for deciding whether a symbol needs $…$.
 */
export function inMathAt(doc: string, pos: number): boolean {
  const before = doc.slice(Math.max(0, doc.lastIndexOf('\n\n', pos - 1)), pos);
  const dollars = (before.replace(/\\\$/g, '').match(/\$/g) ?? []).length;
  if (dollars % 2 === 1) return true;
  const lastOpen = Math.max(before.lastIndexOf('\\('), before.lastIndexOf('\\['));
  const lastClose = Math.max(before.lastIndexOf('\\)'), before.lastIndexOf('\\]'));
  if (lastOpen > lastClose) return true;
  const env = /\\begin\{(equation|align|gather|multline|eqnarray|displaymath|math)\*?\}/g;
  const all = doc.slice(0, pos);
  let open = 0;
  for (const m of all.matchAll(env)) {
    const close = all.indexOf(`\\end{${m[1]}`, (m.index ?? 0) + m[0].length);
    if (close < 0) open++;
  }
  return open > 0;
}
