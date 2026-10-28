// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, expect, it, vi } from 'vitest';
import Projects from '../src/views/Projects.svelte';
import { auth } from '../src/lib/auth.svelte.js';

vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null, ready: true, offline: false, local: false } }));
vi.mock('../src/lib/api.js', async (original) => ({ ...await original<object>(), api: vi.fn().mockResolvedValue({ projects: [] }), isDesktop: false }));

beforeEach(() => { localStorage.clear(); auth.local = false; });

it.each([false, true])('offers ZIP creation on an empty home (local mode: %s)', async (local) => {
  auth.local = local;
  render(Projects);
  expect(screen.getByTestId('import-zip-btn')).toBeTruthy();
  const input = screen.getByTestId('home-zip-input');
  await fireEvent.change(input, { target: { files: [] } });
  expect(screen.queryByRole('dialog')).toBeNull();
  const zip = new File(['zip'], 'My Overleaf Paper.zip', { type: 'application/zip' });
  await fireEvent.change(input, { target: { files: [zip] } });
  expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
  expect(screen.getByTestId('selected-import-source').textContent).toContain(zip.name);
  expect((screen.getByLabelText(local ? 'Name' : 'Project name') as HTMLInputElement).value).toBe('my-overleaf-paper');
  expect(screen.queryByRole('group', { name: 'Start from' })).toBeNull();
});
