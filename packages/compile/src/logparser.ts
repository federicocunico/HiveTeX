export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  file: string;
  line: number;
  severity: Severity;
  message: string;
}

/**
 * Parses pdfTeX / XeTeX / LuaTeX / Tectonic logs into diagnostics. Tracks the input-file stack from
 * the parenthesis structure TeX prints, and understands the common error / warning shapes:
 *   "! Undefined control sequence." followed by "l.12 \foo"
 *   "LaTeX Warning: ... on input line 12."
 *   "Package natbib Warning: ... on input line 12."
 *   "Overfull \hbox (3.2pt too wide) in paragraph at lines 10--12"
 */
export function parseLog(log: string, mainFile = 'main.tex'): Diagnostic[] {
  // TeX hard-wraps log lines at 79 columns; rejoin lines of exactly that width.
  const raw = log.replace(/\r\n/g, '\n').split('\n');
  const lines: string[] = [];
  for (const l of raw) {
    const prev = lines[lines.length - 1];
    if (prev !== undefined && prev.length === 79 && !/^(!|l\.\d)/.test(l)) lines[lines.length - 1] = prev + l;
    else lines.push(l);
  }

  const out: Diagnostic[] = [];
  const stack: string[] = [];
  const cur = () => stack[stack.length - 1] ?? mainFile;
  const norm = (f: string) => f.replace(/^\.[\\/]/, '').replace(/\\/g, '/');

  // Input-file stack from TeX's parenthesis structure. A "(" followed by a path-like token opens a
  // file; parentheses inside ordinary messages are balanced on their own line and are skipped.
  const FILE_EXT = /\.(?:tex|sty|cls|clo|def|cfg|fd|ltx|dtx|aux|bbl|blg|bib|toc|lof|lot|out|map|enc|ldf|cnf|png|jpe?g|pdf|eps)$/i;
  const looksLikePath = (t: string) => /^(?:[A-Za-z]:[\\/]|\.{0,2}\/|\/)/.test(t) || FILE_EXT.test(t) || t.includes('/');
  const trackFiles = (line: string) => {
    if (/^(?:l\.\d+|<inserted text>|<argument>|<recently read>|<\*>|<to be read again>)/.test(line)) return;
    let local = 0;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '(') {
        const m = /^[^\s()]+/.exec(line.slice(k + 1));
        if (m && looksLikePath(m[0])) {
          stack.push(norm(m[0]));
          k += m[0].length;
        } else local++;
      } else if (ch === ')') {
        if (local > 0) local--;
        else if (stack.length > 0) stack.pop();
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith('! ')) {
      let message = line.slice(2).trim();
      let ln = 0;
      // The line reference "l.<n>" appears within the next few lines.
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const m = /^l\.(\d+)\s?(.*)/.exec(lines[j] as string);
        if (m) {
          ln = Number(m[1]);
          i = j;
          break;
        }
      }
      if (/^LaTeX Error:/.test(message)) message = message.replace(/^LaTeX Error:\s*/, '');
      out.push({ file: cur(), line: ln, severity: 'error', message });
      continue;
    }

    const w = /^(LaTeX|Package \S+|Class \S+) (Warning|Info): (.*)/.exec(line);
    if (w) {
      let msg = (w[3] as string).trim();
      let j = i + 1;
      while (j < lines.length && /^\(\S+\)\s{2,}/.test(lines[j] as string)) {
        msg += ` ${(lines[j] as string).replace(/^\(\S+\)\s+/, '').trim()}`;
        j++;
      }
      const lm = /on input line (\d+)\.?/.exec(msg);
      out.push({
        file: cur(),
        line: lm ? Number(lm[1]) : 0,
        severity: w[2] === 'Warning' ? 'warning' : 'info',
        message: msg.replace(/\s*on input line \d+\.?$/, '').trim(),
      });
      i = j - 1;
      continue;
    }

    const box = /^(Overfull|Underfull) \\[hv]box .* (?:at lines? (\d+)(?:--\d+)?|in (?:paragraph|alignment) at lines (\d+))/.exec(line);
    if (box) {
      out.push({ file: cur(), line: Number(box[2] ?? box[3] ?? 0), severity: 'warning', message: line.trim() });
      continue;
    }

    trackFiles(line);
  }
  return out;
}
