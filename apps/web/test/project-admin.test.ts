// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectAdmin, invitationText } from '../src/lib/project-admin.svelte.js';
import type { ProjectSession } from '../src/lib/session.svelte.js';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/lib/api.js', () => ({ api }));
beforeEach(() => api.mockReset());
it('uses the returned full share ID after rename, retaining the internal route', async () => {
  const session = {
    project: { id: 'immutable-id', slug: 'legacy-paper', defaultRole: 'viewer' }, role: 'owner',
    updateShareId: vi.fn(), refreshTicketNow: vi.fn(),
  } as unknown as ProjectSession;
  const admin = new ProjectAdmin(session);
  admin.slug = 'new-paper';
  api.mockImplementation(async (method) => method === 'PATCH' ? { project: { slug: 'new-paper-abcdefghijklmnop' } } : { members: [], bans: [], project: { defaultRole: 'viewer' } });
  expect(await admin.saveSlug()).toBe(true);
  expect(api).toHaveBeenCalledWith('PATCH', '/projects/immutable-id', { slug: 'new-paper' });
  expect(session.updateShareId).toHaveBeenCalledWith('new-paper-abcdefghijklmnop');
  expect(admin.slug).toBe('new-paper-abcdefghijklmnop');
  expect(invitationText(admin.slug, 'https://hivetex.example', true)).toContain('project ID: new-paper-abcdefghijklmnop');
});
