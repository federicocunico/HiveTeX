// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalBuild, SyncIndex } from '@hivetex/compile';
const parser = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('@hivetex/compile', async (original) => ({ ...await original<typeof import('@hivetex/compile')>(), parseSyncTeXGz: parser.parse }));
import { ProjectSession } from '../src/lib/session.svelte.js';

const sessions: ProjectSession[] = [];
afterEach(async () => { for (const s of sessions.splice(0)) await s.close(); parser.parse.mockReset(); });
function fixture() {
  const session = new ProjectSession({ id: 'p-pdf', slug: 'pdf', role: 'owner', defaultRole: 'viewer', passwordProtected: false, epoch: 1 }, { id: 'u', username: 'alice' });
  const internal = session as unknown as { acceptLocalBuild: (b: LocalBuild) => Promise<void>; sourceSeq: number };
  const model = { changeSeq: 12 };
  session.model = model as typeof session.model;
  session.compiler = { isStale: async () => true, stop: () => {} } as unknown as typeof session.compiler;
  sessions.push(session);
  return { session, internal, model };
}
const build = (seq: number, sourceSeq: number, ok = true): LocalBuild => ({
  result: { stateHash: `hash${seq}`, ok, diagnostics: [], log: '', by: { dev: 'd', uname: 'alice' }, at: 1000 + seq, seq },
  ...(ok ? { pdf: new Uint8Array([seq]), synctex: new Uint8Array([seq]), source: { seq: sourceSeq, at: 500, engine: 'pdflatex' as const, stateHash: `hash${seq}` } } : {}),
});
const index = (file: string): SyncIndex => ({ inputs: new Map([[1, file]]), pages: new Map() });

it('counts edits after capture, clears the old mapping immediately, and rejects delayed parsing for an older PDF', async () => {
  const { session, internal, model } = fixture();
  session.syncIndex = index('old.tex');
  let a!: (v: SyncIndex) => void, b!: (v: SyncIndex) => void;
  parser.parse.mockImplementationOnce(() => new Promise((r) => { a = r; })).mockImplementationOnce(() => new Promise((r) => { b = r; }));
  const first = internal.acceptLocalBuild(build(1, 10));
  expect(session.pdf).toEqual(new Uint8Array([1]));
  expect(session.syncIndex).toBeNull();
  expect(session.editsSincePdf).toBe(2); // A completes after source B; completion time must not erase B.
  expect(session.stale).toBe(true);
  model.changeSeq = 15;
  const second = internal.acceptLocalBuild(build(2, 14));
  a(index('a.tex')); await first;
  expect(session.syncIndex).toBeNull();
  b(index('b.tex')); await second;
  expect(session.syncIndex?.inputs.get(1)).toBe('b.tex');
  expect(session.editsSincePdf).toBe(1);
  await internal.acceptLocalBuild(build(3, 15, false));
  expect(session.pdf).toEqual(new Uint8Array([2]));
  expect(session.syncIndex?.inputs.get(1)).toBe('b.tex');
});

it('a later failed build does not prevent the still-visible PDF receiving its own mapping; closing does', async () => {
  const { session, internal } = fixture();
  let resolve!: (v: SyncIndex) => void;
  parser.parse.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const first = internal.acceptLocalBuild(build(1, 12));
  await internal.acceptLocalBuild(build(2, 12, false));
  resolve(index('good.tex')); await first;
  expect(session.syncIndex?.inputs.get(1)).toBe('good.tex');
  const next = internal.acceptLocalBuild(build(3, 12));
  await session.close(); resolve(index('closed.tex')); await next;
  expect(session.syncIndex).toBeNull();
});
