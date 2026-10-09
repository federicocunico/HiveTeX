import { MemoryPersistence, ProjectModel, sha256Hex } from '@p2platex/sync';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { applyImport, planFor } from '../src/lib/import/apply.js';
import { classify, decodeText } from '../src/lib/import/classify.js';
import { detectEngine, detectMain } from '../src/lib/import/detect.js';
import { safePath, skipReason } from '../src/lib/import/filter.js';
import { LIMITS } from '../src/lib/import/limits.js';
import { type LooseItem, inputKind, itemsFromDrop, readArchive, readLoose } from '../src/lib/import/sources.js';
import { gunzipLimited, readTar } from '../src/lib/import/tar.js';
import { readZip, zipDirectory } from '../src/lib/import/zip.js';

// ---- tiny tar writer for fixtures ----
function tarHeader(name: string, size: number, type = '0', link = '') {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, len: number) => h.set(strToU8(s).subarray(0, len), off);
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  put('00000000000\0', 136, 12);
  put(type, 156, 1);
  put(link, 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  for (let i = 148; i < 156; i++) h[i] = 32;
  const sum = h.reduce((a, b) => a + b, 0);
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}
function tar(entries: Array<{ name: string; data?: Uint8Array | string; type?: string; link?: string }>, trailer = true) {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const data = typeof e.data === 'string' ? strToU8(e.data) : (e.data ?? new Uint8Array());
    parts.push(tarHeader(e.name, data.length, e.type ?? '0', e.link ?? ''));
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    parts.push(padded);
  }
  if (trailer) parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const DOC = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n';

describe('classify / decode', () => {
  it('splits text and binary', () => {
    expect(classify('main.tex', strToU8('x')).kind).toBe('text');
    expect(classify('refs.bib', strToU8('x')).kind).toBe('text');
    expect(classify('custom.sty', strToU8('x')).kind).toBe('text');
    expect(classify('logo.png', new Uint8Array([137, 80])).kind).toBe('binary');
    expect(classify('font.otf', new Uint8Array([0, 1, 0])).kind).toBe('binary');
    expect(classify('weird.tex', new Uint8Array([65, 0, 66])).kind).toBe('binary');
    expect(classify('latexmkrc', strToU8('$pdf_mode=1;')).kind).toBe('text');
  });
  it('decodes Latin-1 sources as Windows-1252 and flags them', () => {
    const latin1 = new Uint8Array([...strToU8('perch'), 0xe9]);
    expect(decodeText(latin1)).toEqual({ text: 'perché', converted: true });
    expect(decodeText(strToU8('perché'))).toEqual({ text: 'perché', converted: false });
  });
  it('strips a UTF-8 BOM', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 65])).text).toBe('A');
  });
});

describe('path safety and filtering', () => {
  it('rejects traversal, absolute and drive paths; normalizes backslashes', () => {
    expect(() => safePath('../../etc/passwd')).toThrow(/Unsafe path/);
    expect(() => safePath('/abs.tex')).toThrow(/Unsafe path/);
    expect(() => safePath('C:/x.tex')).toThrow(/Unsafe path/);
    expect(safePath('a\\b.tex')).toBe('a/b.tex');
    expect(safePath('./a/./b.tex')).toBe('a/b.tex');
  });
  it('classifies junk, tool folders and build artifacts; keeps .bbl', () => {
    expect(skipReason('__MACOSX/._main.tex')).toBe('os-metadata');
    expect(skipReason('sub/.DS_Store')).toBe('os-metadata');
    expect(skipReason('.git/config')).toBe('tool-folder');
    expect(skipReason('main.aux')).toBe('build-artifact');
    expect(skipReason('main.synctex.gz')).toBe('build-artifact');
    expect(skipReason('ms.bbl')).toBeNull();
    expect(skipReason('main.tex')).toBeNull();
  });
});

describe('zip', () => {
  it('imports an Overleaf-style zip, skipping build output', () => {
    const z = zipSync({ 'main.tex': strToU8(DOC), 'main.aux': strToU8('x'), 'main.log': strToU8('x'), 'main.synctex.gz': new Uint8Array([1]), 'figures/a.png': new Uint8Array([1, 2]) });
    const b = readArchive('p.zip', z);
    expect(b.files.map((f) => f.path).sort()).toEqual(['figures/a.png', 'main.tex']);
    expect(b.skipped.filter((s) => s.reason === 'build-artifact')).toHaveLength(3);
    expect(b.detection.main).toBe('main.tex');
  });
  it('strips a shared top-level folder', () => {
    const b = readArchive('x.zip', zipSync({ 'paper-main/main.tex': strToU8(DOC), 'paper-main/img/a.png': new Uint8Array([1]), '__MACOSX/paper-main/._main.tex': strToU8('y') }));
    expect(b.files.map((f) => f.path).sort()).toEqual(['img/a.png', 'main.tex']);
  });
  it('rejects traversal entries', () => {
    expect(() => readZip(zipSync({ '../evil.tex': strToU8('x') }))).toThrow(/Unsafe path/);
  });
  it('rejects symlinks', () => {
    const z = zipSync({ 'link.tex': [strToU8('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] as never });
    expect(zipDirectory(z)[0]?.link).toBe(true);
    expect(() => readZip(z)).toThrow(/symbolic link/);
  });
  it('enforces the entry-count cap', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= LIMITS.maxEntries; i++) files[`f${i}.txt`] = new Uint8Array();
    expect(() => readZip(zipSync(files, { level: 0 }))).toThrow(/too many entries/);
  });
  it('refuses a zip bomb before inflating', () => {
    // 11 entries each declaring ~50 MB extracted: refused from the directory alone, nothing is inflated.
    const z = zipSync(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`b${i}.bin`, new Uint8Array(10)])), { level: 9 });
    const dv = new DataView(z.buffer);
    for (let p = 0; p + 4 <= z.length; p++) {
      if (dv.getUint32(p, true) === 0x02014b50) dv.setUint32(p + 24, LIMITS.maxFile - 1, true);
    }
    expect(() => readZip(z)).toThrow(/too large/);
  });
  it('fails cleanly on a truncated zip', () => {
    const z = zipSync({ 'main.tex': strToU8(DOC.repeat(100)) });
    expect(() => readZip(z.subarray(0, z.length - 30))).toThrow(/corrupt/);
  });
  it('round trips export', async () => {
    const m = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
    await m.init();
    await m.createTextNow('main.tex', 'hi');
    m.createBinary('img/x.png', 'h', 3);
    const { exportZip } = await import('../src/lib/import/zip.js');
    const r = readZip(await exportZip(m, async () => new Uint8Array([1, 2, 3])));
    expect(r.files.map((f) => f.path).sort()).toEqual(['img/x.png', 'main.tex']);
  });
});

describe('tar', () => {
  it('imports an arXiv-style tar.gz', () => {
    const t = gzipSync(tar([{ name: 'ms.tex', data: DOC }, { name: 'refs.bib', data: '@misc{a,}' }, { name: 'figs/', type: '5' }, { name: 'figs/plot.pdf', data: new Uint8Array([37, 80, 68, 70]) }]));
    expect(inputKind('2401.00001.tar.gz', t.subarray(0, 512))).toBe('tar');
    const b = readArchive('2401.00001.tar.gz', t);
    expect(b.files.map((f) => f.path).sort()).toEqual(['figs/plot.pdf', 'ms.tex', 'refs.bib']);
    expect(b.detection.main).toBe('ms.tex');
  });
  it('rejects symlinks and hard links', () => {
    expect(() => readTar(tar([{ name: 'a', type: '2', link: '/etc/passwd' }]))).toThrow(/symbolic link/);
    expect(() => readTar(tar([{ name: 'a', type: '1', link: 'b' }]))).toThrow(/hard link/);
  });
  it('rejects traversal', () => {
    expect(() => readTar(tar([{ name: '../x.tex', data: 'x' }]))).toThrow(/Unsafe path/);
  });
  it('detects truncation', () => {
    const t = tar([{ name: 'main.tex', data: DOC.repeat(50) }], false);
    expect(() => readTar(t.subarray(0, 1024))).toThrow(/truncated/);
  });
  it('reads PAX long names', () => {
    const long = `${'d/'.repeat(80)}file.tex`;
    // a PAX record's length prefix counts itself
    const line = (n: number) => `${n} path=${long}\n`;
    let n = line(0).length;
    while (line(n).length !== n) n = line(n).length;
    const r = readTar(tar([{ name: 'PaxHeader', type: 'x', data: line(n) }, { name: 'short', data: 'x' }]));
    expect(r.files[0]?.path).toBe(long);
  });
  it('aborts a gzip bomb early', () => {
    const bomb = gzipSync(new Uint8Array(3 * 1024 * 1024), { level: 9 });
    expect(() => gunzipLimited(bomb, 1024 * 1024)).toThrow(/too large/);
  });
});

describe('detection', () => {
  it('prefers a complete top-level document over included sections', () => {
    const d = detectMain([
      { path: 'paper.tex', text: DOC },
      { path: 'sections/intro.tex', text: '\\section{Intro}' },
    ]);
    expect(d).toMatchObject({ main: 'paper.tex', ambiguous: false });
  });
  it('honors % !TEX root magic comments', () => {
    const d = detectMain([
      { path: 'a.tex', text: DOC },
      { path: 'thesis.tex', text: DOC },
      { path: 'ch/one.tex', text: '% !TEX root = ../thesis.tex\n\\chapter{One}' },
    ]);
    expect(d.main).toBe('thesis.tex');
  });
  it('flags ambiguity with several root documents', () => {
    const d = detectMain([
      { path: 'thesis.tex', text: DOC },
      { path: 'frontmatter.tex', text: DOC },
    ]);
    expect(d.ambiguous).toBe(true);
    expect(d.candidates).toEqual(['frontmatter.tex', 'thesis.tex']);
  });
  it('picks main.tex when present', () => {
    expect(detectMain([{ path: 'main.tex', text: 'x' }, { path: 'b.tex', text: DOC }]).main).toBe('main.tex');
  });
  it('detects the engine', () => {
    expect(detectEngine('\\usepackage{fontspec}')).toBe('xelatex');
    expect(detectEngine('\\usepackage[math]{amsmath, unicode-math}')).toBe('xelatex');
    expect(detectEngine('% \\usepackage{fontspec}\n\\usepackage{graphicx}')).toBeNull();
    expect(detectEngine('% !TEX program = lualatex\n')).toBe('lualatex');
    expect(detectEngine('%!TeX TS-program = XeLaTeX\n')).toBe('xelatex');
  });
});

describe('loose files', () => {
  const item = (path: string, data: Uint8Array | string): LooseItem => {
    const bytes = typeof data === 'string' ? strToU8(data) : data;
    return { path, size: bytes.length, read: async () => bytes };
  };
  it('skips oversized files but keeps the rest', async () => {
    const big: LooseItem = { path: 'video.mp4', size: 80 * 1024 * 1024, read: async () => { throw new Error('must not read'); } };
    const b = await readLoose('upload', [big, item('a.tex', 'x')], { stripRoot: false });
    expect(b.files.map((f) => f.path)).toEqual(['a.tex']);
    expect(b.skipped).toEqual([{ path: 'video.mp4', reason: 'too-large' }]);
  });
  it('keeps a dropped folder name and applies a prefix', async () => {
    const b = await readLoose('drop', [item('paper/main.tex', DOC), item('paper/img/a.png', new Uint8Array([1]))], { stripRoot: false, prefix: 'sub' });
    expect(b.files.map((f) => f.path).sort()).toEqual(['sub/paper/img/a.png', 'sub/paper/main.tex']);
  });
  it('walks dropped folders, skipping tool folders without reading them', async () => {
    type E = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string; file?: (ok: (f: File) => void) => void; createReader?: () => unknown };
    const file = (fullPath: string, body: string): E => ({ isFile: true, isDirectory: false, name: fullPath.split('/').pop() as string, fullPath, file: (ok) => ok(new File([body], fullPath.split('/').pop() as string)) });
    const dir = (fullPath: string, children: E[]): E => ({
      isFile: false,
      isDirectory: true,
      name: fullPath.split('/').pop() as string,
      fullPath,
      createReader: () => {
        let done = false;
        return { readEntries: (ok: (es: E[]) => void) => { ok(done ? [] : children); done = true; } };
      },
    });
    let gitRead = false;
    const git = dir('/paper/.git', []);
    git.createReader = () => { gitRead = true; return { readEntries: (ok: (es: E[]) => void) => ok([]) }; };
    const root = dir('/paper', [file('/paper/main.tex', DOC), dir('/paper/img', [file('/paper/img/a.png', 'png')]), git]);
    const dt = { items: [{ kind: 'file', webkitGetAsEntry: () => root }] } as unknown as DataTransfer;
    const r = await itemsFromDrop(dt);
    expect(r?.hasFolder).toBe(true);
    expect(r?.items.map((i) => i.path).sort()).toEqual(['paper/img/a.png', 'paper/main.tex']);
    expect(gitRead).toBe(false);
    const b = await readLoose('drop', r?.items ?? [], { stripRoot: false });
    expect(b.detection.main).toBe('paper/main.tex');
  });
  it('refuses unsupported archives', () => {
    expect(inputKind('x.rar', strToU8('Rar!'))).toBe('unsupported-archive');
    expect(() => readArchive('x.7z', strToU8('7z..'))).toThrow(/Unsupported archive/);
  });
});

describe('plan and apply', () => {
  async function project() {
    const m = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
    await m.init();
    return m;
  }
  const blobs = new Map<string, Uint8Array>();
  const putBlob = async (b: Uint8Array) => {
    const h = await sha256Hex(b);
    blobs.set(h, b);
    return h;
  };
  const bundle = (files: Record<string, string | Uint8Array>) =>
    readArchive('x.zip', zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));

  it('categorizes added, changed, identical and removed', async () => {
    const m = await project();
    await m.createTextNow('main.tex', 'old');
    await m.createTextNow('same.tex', 'same');
    await m.createTextNow('extra.tex', 'x');
    const plan = await planFor(m, bundle({ 'main.tex': 'new', 'same.tex': 'same', 'add.tex': 'a' }));
    expect(plan.added.map((e) => e.file.path)).toEqual(['add.tex']);
    expect(plan.changed.map((e) => e.file.path)).toEqual(['main.tex']);
    expect(plan.identical).toEqual(['same.tex']);
    expect(plan.removed.map((f) => f.path)).toEqual(['extra.tex']);
  });

  it('keep-existing leaves conflicting files alone; overwrite keeps identity', async () => {
    const m = await project();
    const id = await m.createTextNow('main.tex', 'old');
    const plan = await planFor(m, bundle({ 'main.tex': 'new', 'fig.png': new Uint8Array([1, 2]) }));
    let r = await applyImport(m, putBlob, plan, { mode: 'merge', resolutions: new Map([['main.tex', 'keep']]), defaultResolution: 'overwrite' });
    expect(r).toMatchObject({ added: 1, kept: 1, overwritten: 0 });
    expect((await m.openText(id)).toString()).toBe('old');
    expect(m.find('fig.png')?.kind).toBe('binary');
    r = await applyImport(m, putBlob, await planFor(m, bundle({ 'main.tex': 'new' })), { mode: 'merge', resolutions: new Map(), defaultResolution: 'overwrite' });
    expect(r.overwritten).toBe(1);
    expect(m.find('main.tex')?.id).toBe(id);
    expect((await m.openText(id)).toString()).toBe('new');
  });

  it('replace makes the tree equal to the import', async () => {
    const m = await project();
    await m.createTextNow('old.tex', 'x');
    m.createDir('olddir');
    const plan = await planFor(m, bundle({ 'main.tex': DOC }));
    await applyImport(m, putBlob, plan, { mode: 'replace', resolutions: new Map(), defaultResolution: 'keep', main: 'main.tex', engine: 'xelatex' });
    expect(m.list().map((f) => f.path)).toEqual(['main.tex']);
    expect(m.settings.get('main')).toBe('main.tex');
    expect(m.settings.get('engine')).toBe('xelatex');
  });

  it('leaves the project unchanged when a blob write fails', async () => {
    const m = await project();
    const plan = await planFor(m, bundle({ 'a.tex': 'a', 'b.png': new Uint8Array([1]) }));
    await expect(applyImport(m, async () => { throw new Error('disk full'); }, plan, { mode: 'merge', resolutions: new Map(), defaultResolution: 'overwrite' })).rejects.toThrow(/disk full/);
    expect(m.list()).toEqual([]);
  });
});

describe('docs/import.md stays in sync with the limits', () => {
  it('documents the enforced limits', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(new URL('../../../docs/import.md', import.meta.url), 'utf8');
    expect(doc).toContain(`| ${LIMITS.maxFile / 1024 / 1024} MB |`);
    expect(doc).toContain(`| ${LIMITS.maxTotal / 1024 / 1024} MB |`);
    expect(doc).toContain(`| ${LIMITS.maxEntries} |`);
  });
});
