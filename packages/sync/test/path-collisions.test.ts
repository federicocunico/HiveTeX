import { expect, it } from 'vitest';
import { pathCollisions } from '../src/path-collisions.js';
it('blocks all versions of case, Unicode, reserved and file/directory collisions', () => {
  const paths = ['Intro.tex', 'intro.tex', 'é.tex', 'e\u0301.tex', 'CON.tex', 'sections', 'sections/a.tex'];
  expect(pathCollisions(paths.map((path) => ({ path })))).toEqual(new Set(paths));
  expect(pathCollisions([{ path: 'sections', kind: 'dir' }, { path: 'sections/a.tex', kind: 'text' }])).toEqual(new Set());
  expect(pathCollisions([{path:'same.tex',id:'a'},{path:'same.tex',id:'b'}])).toEqual(new Set(['same.tex']));
  expect(pathCollisions([{path:'same.tex',id:'a'},{path:'same.tex'}])).toEqual(new Set());
});
it('blocks every Windows reserved device name, also with an extension', () => {
  const reserved = ['CONIN$', 'conout$.txt', 'COM0.tex', 'lpt0', 'COM¹.tex', 'LPT²', 'com³.log', 'figs/NUL.png', 'AUX', 'com9.tex'];
  expect(pathCollisions(reserved.map((path) => ({ path })))).toEqual(new Set(reserved));
  const fine = ['console.tex', 'COM10.tex', 'lpt.tex', 'conin.tex', 'com⁴.tex', 'auxiliary.tex'];
  expect(pathCollisions(fine.map((path) => ({ path })))).toEqual(new Set());
});
