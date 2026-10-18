import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, joinProject, newUser, replaceEditorText, uniq } from './helpers.js';
import type { ProjectModel } from '@hivetex/sync';
type P2P = { session: { model: ProjectModel; mesh: import('@hivetex/sync').Mesh }; releaseSync?: () => void };

test('concurrent delete/edit remains downloadable and explicitly restorable from Recovery on both browsers', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const owner = await newUser(a, 'reco'), editor = await newUser(b, 'rece');
    const slug = await createProject(owner.page, uniq('recovery-'));
    await owner.page.getByTestId('settings-btn').click();
    await owner.page.getByLabel('Default role').selectOption('editor');
    await owner.page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect(owner.page.getByText('Saved', { exact: true })).toBeVisible();
    await owner.page.getByRole('button', { name: 'Close' }).click();
    await addFile(owner.page, 'main.tex'); await owner.page.getByRole('treeitem', { name: 'main.tex' }).click();
    await replaceEditorText(owner.page, 'original contribution');
    await joinProject(editor.page, slug); await editor.page.getByRole('treeitem', { name: 'main.tex' }).click();
    await expect(editor.page.locator('.cm-content')).toContainText('original contribution');
    for (const user of [owner, editor]) {
      await expect(user.page.getByTestId('peer-count')).toContainText('1 co-author');
      // Both hold the whole file, confirmed by a peer, before the concurrent delete/edit. Opening a file fetches its
      // content but only a reconcile vouches for it; without that Recovery rightly says "conflict status unknown".
      await expect.poll(() => user.page.evaluate(async () => {
        const s = (window as unknown as { __p2p: P2P }).__p2p.session, docId = `f:${s.model.find('main.tex')!.id}`;
        if (s.model.availability(docId) !== 'complete') await s.mesh.reconcile(docId, { timeoutMs: 3000 });
        return s.model.availability(docId);
      })).toBe('complete');
    }
    for (const user of [owner, editor]) {
      await user.page.evaluate(async () => {
        const p = (window as unknown as { __p2p: P2P }).__p2p;
        await p.session.model.flush();
        const queued: Array<() => void> = [], restore: Array<() => void> = [];
        for (const peer of p.session.mesh.peers) {
          const send = peer.conn.send.bind(peer.conn);
          peer.conn.send = (type, bytes, options) => [0x11, 0x12, 0x14].includes(type)
            ? new Promise<void>((resolve, reject) => queued.push(() => { void send(type, bytes, options).then(resolve, reject); }))
            : send(type, bytes, options);
          restore.push(() => { peer.conn.send = send; });
        }
        p.releaseSync = () => { for (const run of restore) run(); for (const run of queued) run(); };
      });
    }
    const id = await owner.page.evaluate(() => (window as unknown as { __p2p: P2P }).__p2p.session.model.find('main.tex')!.id);
    await Promise.all([
      owner.page.evaluate((id) => { (window as unknown as { __p2p: P2P }).__p2p.session.model.delete(id); }, id),
      editor.page.evaluate(async (id) => { const m = (window as unknown as { __p2p: P2P }).__p2p.session.model; (await m.openText(id)).insert(0, 'later author contribution: '); }, id),
    ]);
    await Promise.all([owner, editor].map((user) => user.page.evaluate(() => (window as unknown as { __p2p: P2P }).__p2p.releaseSync!())));
    for (const user of [owner, editor]) {
      await expect.poll(() => user.page.evaluate((id) => (window as unknown as { __p2p: P2P }).__p2p.session.model.deletedFiles().some((f) => f.id === id && f.conflict), id)).toBe(true).catch(async (error) => {
        for (const peer of [owner, editor]) console.log('recovery state', await peer.page.evaluate(async (id) => {
          const s = (window as unknown as { __p2p: P2P }).__p2p.session;
          return { files: s.model.list(), deleted: s.model.deletedFiles(), text: (await s.model.openText(id)).toString(), history: s.mesh.historyStatus, peers: s.mesh.peers.map((p) => p.claims.uname) };
        }, id));
        throw error;
      });
      await user.page.getByTestId('rail-history').click();
      const recovery = user.page.getByTestId('recovery-section');
      await expect(recovery).toContainText('Deleted file with a later or concurrent contribution');
      await expect(recovery).toContainText(owner.username);
      const download = user.page.waitForEvent('download'); await recovery.getByRole('button', { name: 'Download version', exact: true }).click();
      const stream = await (await download).createReadStream(); const chunks: Buffer[] = [];
      if (!stream) throw new Error('Recovery download is unavailable');
      for await (const part of stream) chunks.push(Buffer.from(part));
      expect(Buffer.concat(chunks).toString()).toContain('later author contribution: original contribution');
    }
    await editor.page.getByTestId('recovery-section').getByRole('button', { name: 'Restore file', exact: true }).click();
    for (const user of [owner, editor]) {
      await user.page.getByTestId('rail-files').click();
      await expect(user.page.getByRole('treeitem', { name: 'main.tex' })).toBeVisible();
      await user.page.getByRole('treeitem', { name: 'main.tex' }).click();
      await expect(user.page.locator('.cm-content')).toContainText('later author contribution: original contribution');
    }
  } finally { await a.close(); await b.close(); }
});
