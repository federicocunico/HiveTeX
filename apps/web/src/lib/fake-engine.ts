import type { CompileEngine, CompileInput, CompileOutput } from '@p2platex/compile';

/**
 * Deterministic stand-in for a TeX engine, enabled only by `localStorage['p2platex.fakeEngine'] = '1'`.
 * It renders the main file's text into a minimal valid PDF so end-to-end tests of election, distribution,
 * preview and staleness do not depend on a TeX installation or network access.
 */
const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');

export function makePdf(lines: string[]): Uint8Array {
  const content = `BT /F1 12 Tf 50 780 Td 14 TL ${lines.slice(0, 50).map((l) => `(${esc(l).slice(0, 90)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export const fakeEngine: CompileEngine = {
  kind: 'wasm',
  supports: ['pdflatex', 'xelatex'],
  async compile(input: CompileInput): Promise<CompileOutput> {
    const main = input.files.find((f) => f.path === input.main)?.text;
    if (main === undefined) return { ok: false, log: `! I can't find file \`${input.main}'.` };
    if (main.includes('\\fail')) return { ok: false, log: `(./${input.main}\n! Undefined control sequence.\nl.1 \\fail\n\n)\n` };
    return { ok: true, pdf: makePdf(main.split('\n')), log: 'fake engine ok' };
  },
};
