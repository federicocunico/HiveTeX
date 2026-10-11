import { describe, expect, it } from 'vitest';
import { type FileList, applyDecisions, conflictCount, mergeFileLists, mergeText, splitLines } from '../src/merge.js';

const base = 'intro\nmethod\nresults\nconclusion\n';

describe('text merge (diff3 by lines)', () => {
  it('splits lines keeping endings, CRLF and a missing final newline', () => {
    expect(splitLines('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    expect(splitLines('')).toEqual([]);
  });

  it('takes the side that changed when only one did', () => {
    expect(mergeText(base, base.replace('method', 'METHOD'), base)).toEqual({ kind: 'mine', text: 'intro\nMETHOD\nresults\nconclusion\n' });
    expect(mergeText(base, base, base.replace('results', 'RESULTS')).kind).toBe('theirs');
    expect(mergeText(base, 'same\n', 'same\n').kind).toBe('theirs');
  });

  it('merges changes to different lines automatically', () => {
    const r = mergeText(base, base.replace('intro', 'INTRO'), base.replace('conclusion', 'CONCLUSION'));
    expect(r).toEqual({ kind: 'clean', text: 'INTRO\nmethod\nresults\nCONCLUSION\n' });
  });

  it('reports changes to the same lines as a conflict and builds the text from decisions', () => {
    const r = mergeText(base, base.replace('method', 'my method'), base.replace('method', 'their method'));
    expect(r.kind).toBe('conflict');
    if (r.kind !== 'conflict') return;
    expect(conflictCount(r.regions)).toBe(1);
    expect(applyDecisions(r.regions, ['mine'])).toBe('intro\nmy method\nresults\nconclusion\n');
    expect(applyDecisions(r.regions, ['theirs'])).toBe('intro\ntheir method\nresults\nconclusion\n');
    expect(applyDecisions(r.regions, ['both'])).toBe('intro\nmy method\ntheir method\nresults\nconclusion\n');
    expect(applyDecisions(r.regions, [{ text: 'our method\n' }])).toBe('intro\nour method\nresults\nconclusion\n');
    expect(() => applyDecisions(r.regions, [])).toThrow('not decided');
  });

  it('keeps both versions intact when the last line has no newline', () => {
    const r = mergeText('a\nb', 'a\nmine', 'a\ntheirs');
    expect(r.kind).toBe('conflict');
    if (r.kind === 'conflict') expect(applyDecisions(r.regions, ['both'])).toBe('a\nmine\ntheirs');
  });

  it('works with CRLF files', () => {
    const b = 'x\r\ny\r\nz\r\n';
    expect(mergeText(b, 'X\r\ny\r\nz\r\n', 'x\r\ny\r\nZ\r\n')).toEqual({ kind: 'clean', text: 'X\r\ny\r\nZ\r\n' });
  });
});

const t = (path: string) => ({ path, kind: 'text' as const, hash: null });
const bin = (path: string, hash: string) => ({ path, kind: 'binary' as const, hash });
const none = new Set<string>();

describe('file list merge', () => {
  it('adds files created on this device', () => {
    const r = mergeFileLists({}, { n: t('new.tex') }, {}, new Set(['n']), none);
    expect(r.add).toEqual([{ id: 'n', state: t('new.tex') }]);
    expect(r.textToMerge).toEqual(['n']);
  });

  it('a file an earlier attempt of the same merge already added still gets its text merged', () => {
    const r = mergeFileLists({}, { n: t('new.tex') }, { n: t('new.tex') }, new Set(['n']), none);
    expect(r.add).toEqual([]);
    expect(r.textToMerge).toEqual(['n']);
  });

  it('a path added on both sides with different files is a conflict', () => {
    const r = mergeFileLists({}, { a: t('x.tex') }, { b: t('x.tex') }, none, none);
    expect(r.conflicts).toEqual([{ type: 'add-add', path: 'x.tex', mineId: 'a', theirsId: 'b' }]);
    expect(r.add).toEqual([]);
  });

  it('a delete here of a file they did not change is applied', () => {
    const r = mergeFileLists({ a: t('a.tex') }, {}, { a: t('a.tex') }, none, none);
    expect(r.remove).toEqual(['a']);
  });

  it('a delete here of a file they changed is a conflict (and the reverse)', () => {
    expect(mergeFileLists({ a: t('a.tex') }, {}, { a: t('a.tex') }, none, new Set(['a'])).conflicts).toEqual([{ type: 'delete-modify', id: 'a', deletedBy: 'mine', path: 'a.tex' }]);
    expect(mergeFileLists({ a: t('a.tex') }, { a: t('a.tex') }, {}, new Set(['a']), none).conflicts).toEqual([{ type: 'delete-modify', id: 'a', deletedBy: 'theirs', path: 'a.tex' }]);
    // their delete of a file this device did not touch stands
    expect(mergeFileLists({ a: t('a.tex') }, { a: t('a.tex') }, {}, none, none).conflicts).toEqual([]);
  });

  it('renames: one side applies, both sides differently is a conflict', () => {
    expect(mergeFileLists({ a: t('a.tex') }, { a: t('b.tex') }, { a: t('a.tex') }, none, none).rename).toEqual([{ id: 'a', path: 'b.tex' }]);
    expect(mergeFileLists({ a: t('a.tex') }, { a: t('b.tex') }, { a: t('c.tex') }, none, none).conflicts).toEqual([{ type: 'rename-rename', id: 'a', mine: 'b.tex', theirs: 'c.tex' }]);
    expect(mergeFileLists({ a: t('a.tex') }, { a: t('b.tex') }, { a: t('b.tex') }, none, none).conflicts).toEqual([]);
  });

  it('a binary changed on both sides is a conflict; on one side it is applied', () => {
    const b: FileList = { i: bin('fig.png', 'h0') };
    expect(mergeFileLists(b, { i: bin('fig.png', 'h1') }, { i: bin('fig.png', 'h0') }, none, none).setHash).toEqual([{ id: 'i', hash: 'h1' }]);
    expect(mergeFileLists(b, { i: bin('fig.png', 'h1') }, { i: bin('fig.png', 'h2') }, none, none).conflicts).toEqual([{ type: 'binary', id: 'i', path: 'fig.png', mine: 'h1', theirs: 'h2' }]);
  });

  it('text files edited here go on to the text merge', () => {
    const r = mergeFileLists({ a: t('a.tex'), b: t('b.tex') }, { a: t('a.tex'), b: t('b.tex') }, { a: t('a.tex'), b: t('b.tex') }, new Set(['b']), none);
    expect(r.textToMerge).toEqual(['b']);
  });
});
