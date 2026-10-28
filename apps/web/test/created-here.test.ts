// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { markCreatedHere, takeCreatedHere } from '../src/lib/created-here.js';

it('retains reliable local creation evidence across module reload without marking joined projects', async () => {
  localStorage.clear();
  markCreatedHere('created-project');
  expect(takeCreatedHere('created-project')).toBe(true);
  vi.resetModules();
  const reopened = await import('../src/lib/created-here.js');
  expect(reopened.takeCreatedHere('created-project')).toBe(true);
  reopened.acknowledgeCreatedHere('created-project');
  expect(reopened.takeCreatedHere('created-project')).toBe(false);
  expect(reopened.takeCreatedHere('joined-project')).toBe(false);
});
