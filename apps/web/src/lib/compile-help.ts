import type { Diagnostic } from '@hivetex/compile';

/**
 * Plain-language help for common compile problems. Each entry explains what the message means and, where a fix is
 * safe and certain, offers it (e.g. load the package that defines a command). Messages without an entry get no
 * explanation: the original message is shown as it is.
 */
export interface Help {
  explanation: string;
  /** A one-click fix: add \usepackage{pkg} to the preamble of the main file. */
  fix?: { label: string; usepackage: string };
}

/** Commands from common packages: command → package. */
const PACKAGE_OF: Record<string, string> = {
  citep: 'natbib', citet: 'natbib', citeauthor: 'natbib', citeyear: 'natbib', citealp: 'natbib',
  includegraphics: 'graphicx', graphicspath: 'graphicx', rotatebox: 'graphicx', scalebox: 'graphicx',
  url: 'url', href: 'hyperref', hypersetup: 'hyperref', autoref: 'hyperref',
  mathbb: 'amssymb', mathfrak: 'amssymb', checkmark: 'amssymb', leqslant: 'amssymb', geqslant: 'amssymb', varnothing: 'amssymb', therefore: 'amssymb',
  eqref: 'amsmath', text: 'amsmath', operatorname: 'amsmath', DeclareMathOperator: 'amsmath', iint: 'amsmath', boldsymbol: 'amsmath', dfrac: 'amsmath', tfrac: 'amsmath', binom: 'amsmath',
  theoremstyle: 'amsthm', qedhere: 'amsthm',
  toprule: 'booktabs', midrule: 'booktabs', bottomrule: 'booktabs', cmidrule: 'booktabs',
  SI: 'siunitx', si: 'siunitx', num: 'siunitx', qty: 'siunitx', unit: 'siunitx', ang: 'siunitx',
  textcolor: 'xcolor', colorbox: 'xcolor', definecolor: 'xcolor',
  multirow: 'multirow', lipsum: 'lipsum', todo: 'todonotes', cref: 'cleveref', Cref: 'cleveref',
  subfloat: 'subfig', degree: 'gensymb', mathscr: 'mathrsfs', bm: 'bm', captionof: 'caption',
  hl: 'soul', sout: 'ulem', ce: 'mhchem', xspace: 'xspace', tikz: 'tikz', usetikzlibrary: 'tikz',
  addbibresource: 'biblatex', printbibliography: 'biblatex', lstinline: 'listings', lstset: 'listings',
};

/** Environments from common packages: environment → package. */
const ENV_PACKAGE: Record<string, string> = {
  align: 'amsmath', 'align*': 'amsmath', gather: 'amsmath', multline: 'amsmath', split: 'amsmath', cases: 'amsmath',
  pmatrix: 'amsmath', bmatrix: 'amsmath', proof: 'amsthm', tikzpicture: 'tikz', algorithm: 'algorithm', algorithmic: 'algorithmic',
  lstlisting: 'listings', minted: 'minted', subfigure: 'subcaption', longtable: 'longtable', tabularx: 'tabularx', multicols: 'multicol',
  landscape: 'pdflscape', wrapfigure: 'wrapfig',
};

/** Packages loaded by \usepackage / \RequirePackage in `preamble`. */
export function loadedPackages(preamble: string): Set<string> {
  const out = new Set<string>();
  const text = preamble.replace(/(^|[^\\])%.*$/gm, '$1');
  for (const m of text.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const p of (m[1] as string).split(',')) out.add(p.trim());
  }
  // packages that load others the help relies on
  if (out.has('amssymb')) out.add('amsfonts');
  if (out.has('mathtools')) out.add('amsmath');
  if (out.has('tikz')) out.add('xcolor');
  if (out.has('biblatex')) out.add('url');
  if (out.has('hyperref')) out.add('url');
  return out;
}

/** Help for one diagnostic. `sourceLine` is the text of the line it points to; `mainText` the main document. */
export function helpFor(d: Diagnostic, sourceLine: string, mainText: string): Help | null {
  const msg = d.message;
  const loaded = loadedPackages(mainText.split(/\\begin\s*\{document\}/)[0] ?? mainText);

  if (/Undefined control sequence/i.test(msg)) {
    const cmds = [...sourceLine.matchAll(/\\([a-zA-Z]+)/g)].map((m) => m[1] as string);
    for (const c of cmds) {
      const pkg = PACKAGE_OF[c];
      if (pkg && !loaded.has(pkg)) {
        return {
          explanation: `\\${c} comes from the ${pkg} package, which this document does not load. Add \\usepackage{${pkg}} to the preamble, or use a command LaTeX knows without it.`,
          fix: { label: `Add ${pkg}`, usepackage: pkg },
        };
      }
    }
    return { explanation: 'LaTeX does not know one of the commands on this line. Check its spelling, or load the package that defines it with \\usepackage in the preamble.' };
  }

  const env = /Environment (\S+) undefined/.exec(msg);
  if (env) {
    const name = env[1] as string;
    const pkg = ENV_PACKAGE[name];
    if (pkg && !loaded.has(pkg)) return { explanation: `The ${name} environment comes from the ${pkg} package. Add \\usepackage{${pkg}} to the preamble.`, fix: { label: `Add ${pkg}`, usepackage: pkg } };
    return { explanation: `LaTeX does not know the ${name} environment. Check its spelling, or load the package that defines it.` };
  }

  if (/Missing \$ inserted/.test(msg))
    return { explanation: 'Something that only works in math (such as ^, _ or a Greek letter like \\alpha) is used in normal text. Put it between dollar signs: $x^2$.' };

  const file = /File [`'](.+?)' not found/.exec(msg);
  if (file)
    return { explanation: `The file ${file[1]} is not in the project. Upload it, or check its name and folder where it is used (\\input, \\include or \\includegraphics).` };

  if (/Missing \\begin\{document\}/.test(msg))
    return { explanation: 'There is text before \\begin{document}, or the main document setting points to a file that is not a complete document. Move the text below \\begin{document}, or set the right main file.' };

  const ended = /\\begin\{(\S+?)\} on input line (\d+) ended by \\end\{(\S+?)\}/.exec(msg);
  if (ended)
    return { explanation: `\\begin{${ended[1]}} on line ${ended[2]} is closed by \\end{${ended[3]}}. Every \\begin{…} needs an \\end{…} with the same name, in the reverse order they were opened.` };

  if (/There's no line here to end/.test(msg))
    return { explanation: 'A line break (\\\\) appears where no line has started, for example right after a heading or an empty line. Remove it; use \\medskip or a blank line for space.' };

  if (/Too many \}'s/.test(msg)) return { explanation: 'There is a closing brace } without a matching opening brace {. Look for an extra } on this line.' };

  if (/Runaway argument|File ended while scanning/.test(msg)) return { explanation: 'A { was opened and never closed, so LaTeX read on to the end. Look for the missing } near this line.' };

  if (/Misplaced alignment tab character &/.test(msg)) return { explanation: '& separates cells in tables and aligned equations only. To print an ampersand in text, write \\&.' };

  if (/Double (superscript|subscript)/.test(msg)) return { explanation: 'Two ^ or two _ in a row are ambiguous. Use braces to group them, like x^{a^b} or x_{i_j}.' };

  const cite = /Citation [`'](.+?)'.*undefined/.exec(msg);
  if (cite)
    return { explanation: `No bibliography entry has the key ${cite[1]}. Check the spelling in \\cite, add the entry to your .bib file, and compile again. Bibliographies need two compiles to settle.` };

  const ref = /Reference [`'](.+?)'.*undefined/.exec(msg);
  if (ref) return { explanation: `No \\label{${ref[1]}} exists. Add the label, or fix the name in \\ref. References need two compiles to settle.` };

  if (/Overfull \\hbox/.test(msg))
    return { explanation: 'A line sticks out into the margin, usually because of a long word, URL or formula LaTeX cannot break. Rephrase, allow a break, or ignore it if it is tiny.' };

  if (/Underfull \\hbox/.test(msg)) return { explanation: 'A line is spaced more loosely than LaTeX likes. Usually harmless; often caused by \\\\ at the end of a paragraph.' };

  return null;
}

/** Where to add \usepackage in the main document: the line of \begin{document} (1-based), or after \documentclass. */
export function preambleInsertLine(mainText: string): number {
  const lines = mainText.split('\n');
  const begin = lines.findIndex((l) => /\\begin\s*\{document\}/.test(l));
  if (begin >= 0) return begin + 1;
  const cls = lines.findIndex((l) => /\\documentclass/.test(l));
  return cls >= 0 ? cls + 2 : 1;
}
