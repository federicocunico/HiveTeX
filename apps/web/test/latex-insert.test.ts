import { describe, expect, it } from 'vitest';
import { scanBib } from '../src/lib/latex.js';
import { bold, cite, displayMath, figure, inMathAt, italic, labelFrom, list, ref, section, symbol, table, wrap } from '../src/lib/latex-insert.js';

describe('toolbar insertions', () => {
  it('wraps a selection and keeps it selected, or places the cursor inside', () => {
    expect(bold('graph')).toEqual({ text: '\\textbf{graph}', anchor: 8, head: 13 });
    expect(italic('')).toEqual({ text: '\\textit{}', anchor: 8 });
    expect(wrap('x', '$', '$')).toEqual({ text: '$x$', anchor: 1, head: 2 });
  });

  it('inserts sectioning with the cursor between the braces', () => {
    expect(section('subsection', '')).toEqual({ text: '\\subsection{}', anchor: 12 });
  });

  it('turns selected lines into list items', () => {
    expect(list('itemize', 'one\ntwo\n').text).toBe('\\begin{itemize}\n  \\item one\n  \\item two\n\\end{itemize}');
    const empty = list('enumerate', '');
    expect(empty.text.slice(0, empty.anchor)).toBe('\\begin{enumerate}\n  \\item ');
  });

  it('builds a figure for a project image with caption and label', () => {
    const f = figure('figures/pipeline.pdf');
    expect(f.text).toContain('\\includegraphics[width=0.8\\linewidth]{figures/pipeline}');
    expect(f.text).toContain('\\label{fig:pipeline}');
    expect(f.text.slice(0, f.anchor).endsWith('\\caption{')).toBe(true);
    expect(labelFrom('img/Contact Map v2.PNG')).toBe('contact-map-v2');
  });

  it('builds a rows × columns table', () => {
    const t = table(3, 4).text;
    expect(t).toContain('\\begin{tabular}{llll}');
    const rows = t.split('\n').filter((l) => l.trim().endsWith('\\\\'));
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.split('&')).toHaveLength(4);
  });

  it('cites, references and wraps display math', () => {
    expect(cite('knuth84').text).toBe('\\cite{knuth84}');
    expect(ref('fig:a').text).toBe('\\ref{fig:a}');
    expect(ref('eq:sum').text).toBe('\\eqref{eq:sum}');
    expect(displayMath('a=b').text).toBe('\\begin{equation}\n  a=b\n\\end{equation}');
  });

  it('wraps symbols in $…$ only outside math', () => {
    expect(symbol('\\leq', false).text).toBe('$\\leq$');
    expect(symbol('\\leq', true).text).toBe('\\leq');
    expect(inMathAt('a $x + ', 7)).toBe(true);
    expect(inMathAt('a $x$ b', 7)).toBe(false);
    expect(inMathAt('\\begin{equation}\n  x = ', 22)).toBe(true);
    expect(inMathAt('\\begin{equation}x\\end{equation} y', 33)).toBe(false);
    expect(inMathAt('cost \\$5 and ', 13)).toBe(false);
  });
});

describe('bibliography scan', () => {
  it('reads key, title, authors and year', () => {
    const bib = '@article{anfinsen73,\n  author = {Christian B. Anfinsen},\n  title = {Principles that Govern the Folding of {P}rotein Chains},\n  year = 1973\n}\n@book{knuth84, title="The TeXbook", author = "Donald Knuth", date = {1984-01-01}}';
    expect(scanBib(bib)).toEqual([
      { key: 'anfinsen73', detail: 'Principles that Govern the Folding of Protein Chains', author: 'Christian B. Anfinsen', year: '1973' },
      { key: 'knuth84', detail: 'The TeXbook', author: 'Donald Knuth', year: '1984' },
    ]);
  });
});
