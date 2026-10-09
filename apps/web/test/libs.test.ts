import { MemoryPersistence, ProjectModel } from '@p2platex/sync';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildIndex, completeAt, scanBib, scanLabels } from '../src/lib/latex.js';
import { replaceProject, searchProject } from '../src/lib/search.js';
import { detectMain } from '../src/lib/import/detect.js';
import { readArchive } from '../src/lib/import/sources.js';
import { exportZip, readZip } from '../src/lib/import/zip.js';

const BIB = `@article{knuth84,
  author = {Donald E. Knuth},
  title = {Literate Programming},
  year = {1984}
}
@book{lamport94, title={LaTeX: A Document Preparation System}, year=1994}
@comment{ignore}
`;

describe('project index and completion (7.2)', () => {
  const idx = buildIndex([
    { path: 'main.tex', kind: 'text', text: '\\section{Intro}\\label{sec:intro}\n\\label{eq:one}' },
    { path: 'refs.bib', kind: 'text', text: BIB },
    { path: 'sections/body.tex', kind: 'text', text: '\\label{fig:a}' },
    { path: 'img/a.png', kind: 'binary' },
  ]);

  it('scans labels and bib keys', () => {
    expect(scanLabels('\\label{a}\\label{b:c}')).toEqual(['a', 'b:c']);
    expect(scanBib(BIB).map((b) => b.key)).toEqual(['knuth84', 'lamport94']);
    expect(scanBib(BIB)[0]?.detail).toBe('Literate Programming');
    expect(idx.labels).toEqual(['eq:one', 'fig:a', 'sec:intro']);
  });

  it('offers knuth84 after \\cite{', () => {
    const r = completeAt('See \\cite{', idx);
    expect(r?.options.map((o) => o.label)).toContain('knuth84');
    expect(r?.from).toBe('See \\cite{'.length);
  });

  it('completes the key after a comma in multi-cite', () => {
    const before = 'x \\citep{knuth84,';
    const r = completeAt(before, idx);
    expect(r?.from).toBe(before.length);
    expect(r?.options.length).toBe(2);
  });

  it('offers labels after \\ref{ and \\eqref{', () => {
    expect(completeAt('\\ref{', idx)?.options.map((o) => o.label)).toEqual(['eq:one', 'fig:a', 'sec:intro']);
    expect(completeAt('\\eqref{eq', idx)?.from).toBe('\\eqref{'.length);
  });

  it('offers project files after \\input{ and commands after a backslash', () => {
    expect(completeAt('\\input{', idx)?.options.map((o) => o.detail)).toContain('sections/body.tex');
    expect(completeAt('\\inc', idx)?.options.map((o) => o.label)).toContain('includegraphics');
    expect(completeAt('plain text', idx)).toBeNull();
  });
});

describe('project search and replace (7.2)', () => {
  async function model() {
    const m = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
    await m.init();
    await m.createTextNow('a.tex', 'Hello World\nhello again\nbye');
    await m.createTextNow('s/b.tex', 'say HELLO to all');
    m.createDir('s');
    return m;
  }
  it('finds matches across files with positions, honoring options', async () => {
    const m = await model();
    const all = await searchProject(m, 'hello');
    expect(all.map((x) => `${x.path}:${x.line}:${x.col}`).sort()).toEqual(['a.tex:1:0', 'a.tex:2:0', 's/b.tex:1:4']);
    expect(await searchProject(m, 'hello', { caseSensitive: true })).toHaveLength(1);
    expect(await searchProject(m, 'h.llo', { regex: true })).toHaveLength(3);
    expect(await searchProject(m, 'ell', { wholeWord: true })).toHaveLength(0);
    expect(await searchProject(m, '(')).toHaveLength(0);
    expect(await searchProject(m, '(', { regex: true })).toHaveLength(0); // invalid regex => no results, no crash
  });
  it('replaces everywhere as collaborative edits', async () => {
    const m = await model();
    expect(await replaceProject(m, 'hello', 'goodbye')).toBe(3);
    expect(await searchProject(m, 'hello')).toHaveLength(0);
    expect((await m.openText(m.find('a.tex')?.id as string)).toString()).toBe('goodbye World\ngoodbye again\nbye');
  });
});

describe('zip export/import (7.5)', () => {
  it('round trips a project', async () => {
    const m = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
    await m.init();
    await m.createTextNow('main.tex', 'hi');
    await m.createTextNow('chap/one.tex', 'one');
    m.createBinary('img/x.png', 'h1', 3);
    const zip = await exportZip(m, async () => new Uint8Array([1, 2, 3]));
    const { files } = readZip(zip);
    expect(files.map((f) => f.path).sort()).toEqual(['chap/one.tex', 'img/x.png', 'main.tex']);
    expect(new TextDecoder().decode(files.find((f) => f.path === 'main.tex')?.bytes)).toBe('hi');
    expect(Array.from(files.find((f) => f.path === 'img/x.png')?.bytes ?? [])).toEqual([1, 2, 3]);
  });
  it('strips a single wrapping folder and detects the main file', () => {
    const b = readArchive('p.zip', zipSync({ 'paper/main.tex': strToU8('x'), 'paper/figures/a.png': new Uint8Array([1]) }));
    expect(b.files.map((f) => f.path).sort()).toEqual(['figures/a.png', 'main.tex']);
    expect(b.detection.main).toBe('main.tex');
    expect(detectMain([{ path: 'thesis.tex', text: '' }, { path: 'a/b.tex', text: '' }]).main).toBe('thesis.tex');
  });
  it('rejects path traversal and ignores macOS junk', () => {
    expect(() => readZip(zipSync({ '../evil.tex': strToU8('x') }))).toThrow(/Unsafe path/);
    expect(() => readZip(zipSync({ '/abs.tex': strToU8('x') }))).toThrow(/Unsafe path/);
    expect(readArchive('j.zip', zipSync({ 'main.tex': strToU8('x'), '__MACOSX/._main.tex': strToU8('y') })).files.map((f) => f.path)).toEqual(['main.tex']);
  });
});
