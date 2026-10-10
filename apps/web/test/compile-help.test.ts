import { parseLog } from '@hivetex/compile';
import { describe, expect, it } from 'vitest';
import { helpFor, loadedPackages, preambleInsertLine } from '../src/lib/compile-help.js';

const MAIN = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nRecent work \\citep{jumper21}.\n\\end{document}\n';

// Excerpts of real pdfTeX logs.
const LOGS = {
  citep: '(./main.tex\n! Undefined control sequence.\nl.4 Recent work \\citep\n                     {jumper21}.\n)',
  typo: '(./main.tex\n! Undefined control sequence.\nl.4 Recent work \\cyte\n                    {x}\n)',
  dollar: '(./main.tex\n! Missing $ inserted.\n<inserted text> \n                $\nl.7 x^\n      2\n)',
  file: "(./main.tex\n! LaTeX Error: File `sections/intro.tex' not found.\n\nType X to quit or <RETURN> to proceed,\nl.9 \\input{sections/intro}\n)",
  begin: '(./main.tex\n! LaTeX Error: Missing \\begin{document}.\n\nl.2 H\n     ello\n)',
  env: '(./main.tex\n! LaTeX Error: Environment align undefined.\n\nl.12 \\begin{align}\n)',
  cite: "(./main.tex\nLaTeX Warning: Citation `anfinsen73' on page 1 undefined on input line 15.\n)",
  overfull: '(./main.tex\nOverfull \\hbox (12.3pt too wide) in paragraph at lines 20--22\n)',
  unknown: '(./main.tex\n! Something nobody has seen before.\nl.3 x\n)',
};

const first = (log: string) => parseLog(log)[0] as Parameters<typeof helpFor>[0];

describe('compile help', () => {
  it('explains a command from a package that is not loaded, and offers to load it', () => {
    const h = helpFor(first(LOGS.citep), 'Recent work \\citep{jumper21}.', MAIN);
    expect(h?.explanation).toContain('\\citep comes from the natbib package');
    expect(h?.fix).toEqual({ label: 'Add natbib', usepackage: 'natbib' });
  });

  it('does not offer a package that is already loaded', () => {
    const withNatbib = MAIN.replace('\\usepackage{amsmath}', '\\usepackage[numbers]{natbib,amsmath}');
    expect(helpFor(first(LOGS.citep), 'Recent work \\citep{jumper21}.', withNatbib)?.fix).toBeUndefined();
  });

  it('explains unknown commands, missing $, missing files, missing \\begin{document}, environments', () => {
    expect(helpFor(first(LOGS.typo), 'Recent work \\cyte{x}', MAIN)?.explanation).toContain('Check its spelling');
    expect(helpFor(first(LOGS.dollar), 'x^2', MAIN)?.explanation).toContain('dollar signs');
    expect(helpFor(first(LOGS.file), '\\input{sections/intro}', MAIN)?.explanation).toContain('sections/intro.tex is not in the project');
    expect(helpFor(first(LOGS.begin), 'Hello', MAIN)?.explanation).toContain('before \\begin{document}');
    const env = helpFor(first(LOGS.env), '\\begin{align}', '\\documentclass{article}\\begin{document}');
    expect(env?.fix?.usepackage).toBe('amsmath');
  });

  it('explains undefined citations and overfull boxes', () => {
    expect(helpFor(first(LOGS.cite), '', MAIN)?.explanation).toContain('anfinsen73');
    expect(helpFor(first(LOGS.overfull), '', MAIN)?.explanation).toContain('margin');
  });

  it('invents nothing for errors it does not know', () => {
    const d = first(LOGS.unknown);
    expect(d.message).toBe('Something nobody has seen before.');
    expect(helpFor(d, 'x', MAIN)).toBeNull();
  });

  it('finds the preamble and the loaded packages', () => {
    expect(preambleInsertLine(MAIN)).toBe(3);
    expect(preambleInsertLine('\\documentclass{article}\nText')).toBe(2);
    expect([...loadedPackages('\\usepackage[utf8]{inputenc}\n% \\usepackage{natbib}\n\\usepackage{a, b}')]).toEqual(['inputenc', 'a', 'b']);
  });
});
