import { ROOT_DOC_ID } from '@p2platex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryPersistence } from '../src/persistence.js';
import { ProjectModel } from '../src/model.js';
import { waitFor } from './helpers.js';
import { Net, converged, text } from './net.js';

let net: Net;
afterEach(() => net?.destroy());

describe('ProjectModel.applyBatch', () => {
  it('lands all file-table changes in one root update and keeps overwritten files', async () => {
    const m = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
    await m.init();
    const introId = await m.createTextNow('intro.tex', 'old intro');
    const oldId = await m.createTextNow('old.tex', 'gone');
    const rootUpdates: number[] = [];
    m.onDocUpdate((docId) => {
      if (docId === ROOT_DOC_ID) rootUpdates.push(1);
    });
    const { created } = await m.applyBatch([
      { op: 'text', path: 'main.tex', text: '\\documentclass{article}' },
      { op: 'text', path: 'sec/a.tex', text: 'A' },
      { op: 'binary', path: 'img/x.png', hash: 'h1', size: 3 },
      { op: 'text', path: 'intro.tex', text: 'new intro', id: introId },
      { op: 'delete', id: oldId },
      { op: 'setting', key: 'main', value: 'main.tex' },
    ]);
    expect(rootUpdates).toHaveLength(1);
    expect(m.list().map((f) => f.path)).toEqual(['img/x.png', 'intro.tex', 'main.tex', 'sec/a.tex']);
    expect(m.find('intro.tex')?.id).toBe(introId);
    expect((await m.openText(introId)).toString()).toBe('new intro');
    expect((await m.openText(created.get('main.tex') as string)).toString()).toBe('\\documentclass{article}');
    expect(m.settings.get('main')).toBe('main.tex');
  });

  it('rejects unsafe paths before changing anything', async () => {
    const m = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
    await m.init();
    await expect(
      m.applyBatch([
        { op: 'text', path: 'ok.tex', text: 'x' },
        { op: 'text', path: '../evil.tex', text: 'x' },
      ]),
    ).rejects.toThrow(/Invalid file path/);
    expect(m.list()).toEqual([]);
  });

  it('a connected peer receives every imported file with content', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const ops = Array.from({ length: 50 }, (_, i) => ({ op: 'text' as const, path: `f/${i}.tex`, text: `file ${i}` }));
    const { created } = await a.model.applyBatch(ops);
    await waitFor(() => b.model.list().length === 50);
    const id = created.get('f/7.tex') as string;
    await b.mesh.openDoc(`f:${id}`);
    await converged([a, b], id);
    expect(await text(b, id)).toBe('file 7');
  });
});
