import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../apps/web/src/templates');

/** Actual shipped sources, with an image added to exercise binary input too. */
export function compileTemplate(name: 'article' | 'report') {
  const dir = join(root, name);
  const files: Array<{ path: string; kind: 'text'; text: string } | { path: string; kind: 'binary'; bytes: Uint8Array }> = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tex|bib)$/.test(entry.name)) files.push({ path: relative(dir, path).replaceAll('\\', '/'), kind: 'text', text: readFileSync(path, 'utf8') });
    }
  };
  walk(dir);
  const main = files.find((f) => f.path === 'main.tex');
  if (!main || main.kind !== 'text') throw new Error(`Missing ${name} main`);
  main.text = main.text.replace('\\end{document}', '\\includegraphics[width=1cm]{pixel.png}\n\\end{document}');
  files.push({ path: 'pixel.png', kind: 'binary', bytes: new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4v4UBAARpAbSv3l+wAAAAAElFTkSuQmCC', 'base64')) });
  return { files, main: 'main.tex', engine: 'pdflatex' as const, stateHash: name };
}

export async function pdfText(bytes: Uint8Array) {
  const { getDocument } = await import('../../apps/web/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      pages.push((await page.getTextContent()).items.map((i) => 'str' in i ? i.str : '').join(' '));
    }
    return pages.join('\n');
  } finally { await task.destroy(); }
}
