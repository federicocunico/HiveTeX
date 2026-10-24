import { expect, it } from 'vitest';
import { explainFailure } from '../src/failure.js';

it.each([
  ['No LaTeX on this computer yet. Set up the quick compiler in Account > Compiler.', 'compiler', 'setup'],
  ['The TeX package server is unavailable and no compiler format is cached.', 'compiler', 'setup'],
  ['This device cannot run lualatex. Set up a compatible local compiler.', 'engine', 'setup'],
  ['! LaTeX Error: File `missing.sty\' not found.', 'package', 'retry'],
  ['! Could not download package: HTTP 503', 'package', 'retry'],
  ['! Compile timed out after 120 s', 'timeout', 'retry'],
  ['! Compiler worker crashed; retry to start a fresh worker.', 'runtime', 'retry'],
])('classifies a failure before source diagnostics: %s', (log, kind, action) => {
  const result = explainFailure(log);
  expect(result).toMatchObject({ kind, action });
  expect(result.summary.length).toBeGreaterThan(10);
  expect(result.recovery.length).toBeGreaterThan(10);
});

it('names unavailable inputs and preserves source diagnostics with a location', () => {
  expect(explainFailure('incomplete', [], ['image.png'])).toMatchObject({ kind: 'input', action: 'sync', summary: expect.stringContaining('image.png') });
  expect(explainFailure('log', [{ file: 'chapter.tex', line: 12, severity: 'error', message: 'Undefined control sequence' }])).toMatchObject({ kind: 'source', summary: 'Undefined control sequence', recovery: expect.stringContaining('chapter.tex, line 12') });
});
