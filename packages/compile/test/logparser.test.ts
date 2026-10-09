import { describe, expect, it } from 'vitest';
import { parseLog } from '../src/index.js';

// Abridged but structurally faithful pdfTeX / XeTeX output.
const PDFTEX = String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.25 (TeX Live 2023) (preloaded format=pdflatex)
entering extended mode
(./main.tex
LaTeX2e <2023-11-01> patch level 1
(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls
Document Class: article 2023/05/17 v1.4n Standard LaTeX document class
(/usr/share/texlive/texmf-dist/tex/latex/base/size10.clo))
(/usr/share/texlive/texmf-dist/tex/latex/graphicx/graphicx.sty)
(./main.aux)
(./sections/intro.tex
Overfull \hbox (12.3pt too wide) in paragraph at lines 14--15
[]\OT1/cmr/m/n/10 Lorem ipsum dolor sit amet, consectetur
! Undefined control sequence.
l.17     \foo
              bar
The control sequence at the end of the top line
of your error message was never \def'ed.

)
LaTeX Warning: Reference \`fig:one' on page 1 undefined on input line 23.

Package natbib Warning: Citation \`knuth84' on page 1 undefined on input line 25.

! LaTeX Error: File \`missing.png' not found.

See the LaTeX manual or LaTeX Companion for explanation.
Type  H <return>  for immediate help.
 ...

l.31 \includegraphics{missing.png}

)
(./main.bbl)
Output written on main.pdf (1 page, 12345 bytes).
`;

describe('log parser (8.4)', () => {
  const d = parseLog(PDFTEX, 'main.tex');

  it('extracts errors with file and line from the file stack', () => {
    const undef = d.find((x) => x.message.startsWith('Undefined control sequence'));
    expect(undef).toMatchObject({ severity: 'error', file: 'sections/intro.tex', line: 17 });
  });

  it('strips the LaTeX Error: prefix and finds the line', () => {
    const miss = d.find((x) => x.message.includes('missing.png'));
    expect(miss).toMatchObject({ severity: 'error', line: 31 });
    expect(miss?.message.startsWith('LaTeX Error')).toBe(false);
  });

  it('extracts LaTeX and package warnings with their input line', () => {
    expect(d.find((x) => x.message.includes('fig:one'))).toMatchObject({ severity: 'warning', line: 23 });
    expect(d.find((x) => x.message.includes('knuth84'))).toMatchObject({ severity: 'warning', line: 25 });
  });

  it('reports overfull boxes as warnings at the first line', () => {
    const box = d.find((x) => x.message.startsWith('Overfull'));
    expect(box).toMatchObject({ severity: 'warning', line: 14, file: 'sections/intro.tex' });
  });

  it('attributes nothing to class/style files and falls back to the main file', () => {
    expect(d.every((x) => !x.file.endsWith('.cls') && !x.file.endsWith('.sty'))).toBe(true);
  });

  it('returns nothing for a clean log', () => {
    expect(parseLog('This is pdfTeX\n(./main.tex\n)\nOutput written on main.pdf (1 page).\n')).toEqual([]);
  });

  it('handles XeTeX-style file-line-error messages and Tectonic errors', () => {
    const xe = `(./main.tex\n! Emergency stop.\nl.5 \\end{documen}\n\n)\n`;
    expect(parseLog(xe)[0]).toMatchObject({ severity: 'error', line: 5, file: 'main.tex' });
  });

  it('joins lines hard-wrapped at 79 columns', () => {
    const long = 'LaTeX Warning: ' + 'x'.repeat(64);
    expect(long.length).toBe(79);
    const log = `(./main.tex\n${long}\nyyy on input line 9.\n)\n`;
    expect(parseLog(log)[0]).toMatchObject({ line: 9, severity: 'warning' });
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), 'utf8');

describe.each([['pdfTeX', 'pdftex-miktex.log'], ['XeTeX', 'xetex-miktex.log']])('real %s log (8.4)', (_n, file) => {
  const d = parseLog(fixture(file), 'main.tex');
  it('attributes the undefined macro to the included file and line', () => {
    expect(d.find((x) => x.message.startsWith('Undefined control sequence'))).toMatchObject({ severity: 'error', file: 'sections/intro.tex', line: 4 });
  });
  it('attributes the missing image to the main file', () => {
    expect(d.find((x) => x.message.includes('missing-image'))).toMatchObject({ severity: 'error', file: 'main.tex', line: 7 });
  });
  it('finds math-mode errors in the included file', () => {
    expect(d.filter((x) => x.message.startsWith('Missing $')).map((x) => `${x.file}:${x.line}`)).toEqual(['sections/intro.tex:2', 'sections/intro.tex:3']);
  });
  it('reports undefined references and citations as warnings with lines', () => {
    expect(d.find((x) => x.message.includes('fig:one'))).toMatchObject({ severity: 'warning', line: 6 });
    expect(d.find((x) => x.message.includes('knuth84'))).toMatchObject({ severity: 'warning', line: 6 });
  });
  it('reports the overfull box', () => {
    expect(d.find((x) => x.message.startsWith('Overfull'))).toMatchObject({ severity: 'warning', file: 'sections/intro.tex', line: 2 });
  });
});
