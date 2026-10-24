/** Original deterministic stress fixture: varied logical and wrapped lines, never a repeated dummy paragraph. */
export function manuscript(eol: '\n' | '\r\n' = '\n'): string {
  const lines = ['\\documentclass{report}', '', '\\usepackage[utf8]{inputenc}', '', '\\begin{document}', ''];
  while (lines.length < 6199) {
    const n = lines.length + 1;
    const text = n % 31 === 0 ? ''
      : n % 113 === 0 ? `\\chapter{Experiment ${n}}`
      : n % 37 === 0 ? `\\section{Observation ${n}}\\label{sec:${n}}`
      : n % 19 === 0 ? `\\[ E_{${n}} = \\sum_{i=1}^{${n % 9 + 2}} \\frac{i^2}{1+i} \\]`
      : n % 11 === 0 ? `% Note ${n}: café, naïve, αβγ; measurement and wrapping must share the same baseline.`
      : `Observation ${n}: ${Array.from({ length: n % 5 + 1 }, (_, i) => `sample ${i + 1} measures stability at source position ${n}, with distinct prose and a reproducible result.`).join(' ')}`;
    lines.push(text);
  }
  lines.push('\\end{document}');
  return lines.join(eol);
}
