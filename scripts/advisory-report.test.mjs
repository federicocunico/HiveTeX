import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticMessage } from './advisory-report.mjs';

test('failed or unavailable diagnostics are warnings, including setup failure', () => {
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) assert.match(diagnosticMessage('browser', result), /did not pass/);
});
test('passing-on-retry diagnostics still warn; a clean result does not', () => {
  assert.match(diagnosticMessage('browser', 'success', { stats: { unexpected: 0, flaky: 2 } }), /2 tests passed only on retry/);
  assert.equal(diagnosticMessage('browser', 'success', { stats: { unexpected: 0, flaky: 0 } }), null);
});
