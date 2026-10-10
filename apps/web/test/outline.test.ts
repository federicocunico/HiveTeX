import { describe, expect, it } from 'vitest';
import { buildOutline, cleanTitle, currentHeading } from '../src/lib/outline.js';

const files: Record<string, string> = {
  'main.tex': [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Introduction}\\label{sec:intro}',
    '% \\section{Commented out}',
    'Text with 50\\% done.',
    '\\subsection{Related work}',
    '\\input{sections/method}',
    '\\section*{Acknowledgements}',
    '\\end{document}',
  ].join('\n'),
  'sections/method.tex': '\\section[Short]{Method: \\emph{graphs}}\n\\subsection{Residue graphs}\n\\include{sections/results}\n',
  'sections/results.tex': '\\section{Results}\n',
};
const read = (p: string) => files[p];

describe('outline', () => {
  it('lists headings in reading order across \\input and \\include, skipping comments', () => {
    const o = buildOutline('main.tex', read);
    expect(o.map((e) => `${e.number} ${e.title}`.trim())).toEqual([
      '1 Introduction',
      '1.1 Related work',
      '2 Method: graphs',
      '2.1 Residue graphs',
      '3 Results',
      'Acknowledgements',
    ]);
    expect(o[2]).toMatchObject({ file: 'sections/method.tex', line: 1, level: 2 });
    expect(o[5]).toMatchObject({ file: 'main.tex', line: 8 });
  });

  it('numbers chapters in a report', () => {
    const o = buildOutline('t.tex', (p) => (p === 't.tex' ? '\\chapter{One}\n\\section{A}\n\\chapter{Two}\n\\section{B}' : undefined));
    expect(o.map((e) => e.number)).toEqual(['1', '1.1', '2', '2.1']);
  });

  it('falls back to every .tex file when the main file is missing, and ignores include cycles', () => {
    const cyc = { 'a.tex': '\\section{A}\\input{b}', 'b.tex': '\\section{B}\\input{a}' } as Record<string, string>;
    expect(buildOutline('main.tex', (p) => cyc[p], ['b.tex', 'a.tex']).map((e) => e.title)).toEqual(['A', 'B']);
  });

  it('finds the heading that holds the cursor', () => {
    const o = buildOutline('main.tex', read);
    expect(currentHeading(o, 'main.tex', 5)?.title).toBe('Introduction');
    expect(currentHeading(o, 'sections/method.tex', 2)?.title).toBe('Residue graphs');
    expect(currentHeading(o, 'main.tex', 1)).toBeNull();
  });

  it('cleans titles', () => {
    expect(cleanTitle('Results on \\textbf{CASP15}~data\\label{x}')).toBe('Results on CASP15 data');
  });
});
