// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import { explainFailure } from '@hivetex/compile';
import ProblemsPanel from '../src/components/workspace/ProblemsPanel.svelte';

it.each([
  ['No LaTeX on this computer yet.', [], 'Compiler setup'],
  ['This device cannot run lualatex.', [], 'Compiler setup'],
  ['Missing source', ['figure.png'], 'Sync inputs'],
  ['Could not download package: HTTP 503', [], 'Retry build'],
])('shows the cause and recovery even when collapsed: %s', (log, missing, action) => {
  render(ProblemsPanel, { diagnostics: [], failed: true, failure: explainFailure(log, [], missing), expanded: false, onToggle: vi.fn(), onGo: vi.fn(), onRetry: vi.fn(), onSetup: vi.fn(), onSync: vi.fn() });
  expect(screen.queryByText('No problems')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(explainFailure(log, [], missing).summary);
  expect(screen.getByRole('button', { name: action })).toBeTruthy();
});

it('never labels a compiler setup note as No problems', () => {
  render(ProblemsPanel, { diagnostics: [], note: 'Compiler unavailable', expanded: true, onToggle: vi.fn(), onGo: vi.fn() });
  expect(screen.queryByText('No problems')).toBeNull();
  expect(screen.getByText('Build blocked')).toBeTruthy();
});
