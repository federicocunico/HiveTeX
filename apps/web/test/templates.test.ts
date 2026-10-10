import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TEMPLATES, templateFiles } from '../src/lib/templates.js';

describe('bundled templates', () => {
  it('lists the six templates with Blank first', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(['blank', 'article', 'report', 'beamer', 'letter', 'cv']);
    for (const t of TEMPLATES) {
      expect(t.name, t.id).toBeTruthy();
      expect(t.description, t.id).toBeTruthy();
    }
  });

  it('blank has no files; every other template contains its main file', async () => {
    expect((await templateFiles('blank')).size).toBe(0);
    for (const t of TEMPLATES.filter((x) => x.id !== 'blank')) {
      const files = await templateFiles(t.id);
      expect(files.has(t.main), `${t.id} has ${t.main}`).toBe(true);
      expect(files.get(t.main), t.id).toMatch(/\\documentclass/);
    }
  });

  it('explains its main parts in comments', async () => {
    for (const t of TEMPLATES.filter((x) => x.id !== 'blank')) {
      const main = (await templateFiles(t.id)).get(t.main) ?? '';
      const comments = main.split('\n').filter((l) => /^\s*%/.test(l));
      expect(comments.length, `${t.id} comment lines`).toBeGreaterThanOrEqual(4);
    }
  });
});

// Compiles each template with the local TeX installation when there is one (developer machines, the CI TeX job).
const hasTex = spawnSync('pdflatex', ['--version'], { encoding: 'utf8' }).status === 0;
const work: string[] = [];
afterAll(() => {
  for (const d of work) rmSync(d, { recursive: true, force: true });
});

function run(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000 });
}

describe.skipIf(!hasTex)('templates compile with TeX', () => {
  for (const t of TEMPLATES.filter((x) => x.id !== 'blank')) {
    it(`${t.id} compiles without errors`, { timeout: 600_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), `hivetex-tpl-${t.id}-`));
      work.push(dir);
      for (const [path, text] of await templateFiles(t.id)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      const job = t.main.replace(/\.tex$/, '');
      const tex = () => run('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', t.main], dir);
      let r = tex();
      expect(r.status, `${t.id} first pass:\n${r.stdout.slice(-2000)}`).toBe(0);
      const aux = readFileSync(join(dir, `${job}.aux`), 'utf8');
      if (/\\bibdata/.test(aux)) {
        const b = run('bibtex', [job], dir);
        expect(b.status, `${t.id} bibtex:\n${b.stdout}`).toBe(0);
      }
      r = tex();
      r = tex();
      expect(r.status, `${t.id} final pass:\n${r.stdout.slice(-2000)}`).toBe(0);
      expect(existsSync(join(dir, `${job}.pdf`))).toBe(true);
      expect(readFileSync(join(dir, `${job}.log`), 'utf8')).not.toMatch(/^! /m);
    });
  }
});
