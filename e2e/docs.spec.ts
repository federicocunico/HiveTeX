import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addFile, createProject, newUser, uniq } from './helpers.js';

type Cmd = { id: string; title: string; keys: string[]; editor: boolean; available: boolean };
const DOC = new URL('../docs/interface.md', import.meta.url);
const START = /<!-- shortcuts:start[^>]*-->/;
const END = '<!-- shortcuts:end -->';

/** The shortcut table in docs/interface.md is generated from the live command registry; this keeps them equal. */
test('docs: the shortcut table matches the command registry', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: p } = await newUser(ctx, 'docs');
  await createProject(p, uniq('docs-'));
  await addFile(p, 'main.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  const cmds = await p.evaluate(() => (window as unknown as { __commands: () => Cmd[] }).__commands());
  const rows = cmds
    .filter((c) => c.keys.length)
    .map((c) => `| ${c.title} | ${c.keys.join(' or ')}${c.editor ? ' (in the editor)' : ''} |`)
    .sort((a, b) => a.localeCompare(b));
  const table = ['', '| Action | Keys |', '|---|---|', ...rows, ''].join('\n');

  const doc = readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
  const start = doc.match(START);
  const at = start ? (start.index ?? 0) + start[0].length : -1;
  const end = doc.indexOf(END);
  expect(at > 0 && end > at, 'markers present').toBe(true);
  if (process.env.UPDATE_DOCS) writeFileSync(DOC, doc.slice(0, at) + table + doc.slice(end));
  else expect(doc.slice(at, end), 'run with UPDATE_DOCS=1 to refresh docs/interface.md').toBe(table);
  await ctx.close();
});
