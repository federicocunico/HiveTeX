import { beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_BRANCH, BACKUP_TRAILER, GitHubClient, gitBlobSha, importRepo, pushBackup } from '../src/index.js';
import { FakeGitHub } from '../src/testing.js';

let gh: FakeGitHub;
let client: GitHubClient;
const repo = { owner: 'octocat', repo: 'paper' };
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));

beforeEach(() => {
  gh = new FakeGitHub();
  client = new GitHubClient('tok', gh.fetch);
});

describe('git blob ids', () => {
  it('matches git hash-object', async () => {
    expect(await gitBlobSha(enc('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a'); // echo hello | git hash-object --stdin
    expect(await gitBlobSha(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'); // empty blob
  });
});

describe('GitHub backup push (10.2)', () => {
  it('seeds an empty repository, then commits the project', async () => {
    gh.repo('octocat/paper', { empty: true });
    const r = await pushBackup(client, repo, 'main', files({ 'main.tex': 'v1', 'figs/a.png': 'PNG' }), { message: 'alice: first backup' });
    expect(r.noop).toBe(false);
    expect(r.branch).toBe('main');
    const state = gh.repo('octocat/paper').files('main');
    expect(state['main.tex']).toBe('v1');
    expect(state['figs/a.png']).toBe('PNG');
    expect(JSON.parse(state['.hivetex.json'] as string).paths).toEqual(['figs/a.png', 'main.tex']);
    const head = gh.repo('octocat/paper').refs.get('main') as string;
    expect(gh.repo('octocat/paper').commits.get(head)?.message).toContain(BACKUP_TRAILER);
  });

  it('writes a version 2 marker with the project identity, so a clone opens as the project', async () => {
    gh.repo('octocat/paper', { empty: true });
    const project = { id: 'p-123', slug: 'my-paper-2026' };
    await pushBackup(client, repo, 'main', files({ 'main.tex': 'v1' }), { message: 'm', project });
    const marker = JSON.parse(gh.repo('octocat/paper').files('main')['.hivetex.json'] as string);
    expect(marker).toEqual({ version: 2, project, paths: ['main.tex'] });
    const got = await importRepo(client, repo, 'main');
    expect([...got.keys()]).toEqual(['main.tex']); // the marker is bookkeeping, never a project file
  });

  it('uploads only changed blobs on later backups and does nothing when unchanged', async () => {
    gh.repo('octocat/paper', { empty: true });
    await pushBackup(client, repo, 'main', files({ 'a.tex': 'A', 'b.tex': 'B', 'c.tex': 'C' }), { message: 'm' });
    const before = gh.stats.blobsCreated;
    const r2 = await pushBackup(client, repo, 'main', files({ 'a.tex': 'A', 'b.tex': 'B2', 'c.tex': 'C' }), { message: 'm' });
    expect(r2.uploaded).toBe(1);
    expect(gh.stats.blobsCreated - before).toBe(1); // only the changed file; manifest paths are unchanged
  });

  it('is a no-op when nothing changed', async () => {
    gh.repo('octocat/paper', { empty: true });
    await pushBackup(client, repo, 'main', files({ 'a.tex': 'A' }), { message: 'm' });
    const commits = gh.stats.commits;
    const r = await pushBackup(client, repo, 'main', files({ 'a.tex': 'A' }), { message: 'm' });
    expect(r.noop).toBe(true);
    expect(gh.stats.commits).toBe(commits);
  });

  it('mirrors deletions of files it manages but leaves foreign files alone', async () => {
    const r = gh.repo('octocat/paper', { empty: true });
    await pushBackup(client, repo, 'main', files({ 'a.tex': 'A', 'old.tex': 'O' }), { message: 'm' });
    const head1 = r.refs.get('main') as string;
    gh.foreignCommit('octocat/paper', 'main', { 'LICENSE': 'MIT' }); // a collaborator's file
    const res = await pushBackup(client, repo, 'main', files({ 'a.tex': 'A' }), { message: 'm', lastSha: head1 });
    // main moved with a foreign commit => backup branch, but deletion logic is exercised there too
    const target = res.branch === 'main' ? r.files('main') : r.files(BACKUP_BRANCH);
    expect(target['old.tex']).toBeUndefined();
    expect(target['a.tex']).toBe('A');
    expect(target.LICENSE).toBe('MIT');
  });

  it('never force-pushes: foreign commits on the bound branch divert the backup to hivetex/backup', async () => {
    const r = gh.repo('octocat/paper', { empty: true });
    const first = await pushBackup(client, repo, 'main', files({ 'a.tex': 'A' }), { message: 'm' });
    const foreign = gh.foreignCommit('octocat/paper', 'main', { 'README.md': 'edited online' });
    const second = await pushBackup(client, repo, 'main', files({ 'a.tex': 'A2' }), { message: 'm', lastSha: first.commit });
    expect(second.diverged).toBe(true);
    expect(second.branch).toBe(BACKUP_BRANCH);
    expect(r.refs.get('main')).toBe(foreign); // main untouched
    expect(r.files(BACKUP_BRANCH)['a.tex']).toBe('A2');
    expect(gh.stats.forcePushAttempts).toBe(0);
    // the next backup continues on the backup branch
    const third = await pushBackup(client, repo, 'main', files({ 'a.tex': 'A3' }), { message: 'm', lastSha: first.commit });
    expect(third.branch).toBe(BACKUP_BRANCH);
    expect(r.files(BACKUP_BRANCH)['a.tex']).toBe('A3');
  });

  it('continues normally when the head was pushed by another HiveTeX device', async () => {
    const r = gh.repo('octocat/paper', { empty: true });
    const a = await pushBackup(client, repo, 'main', files({ 'a.tex': 'A' }), { message: 'device 1' });
    const b = await pushBackup(client, repo, 'main', files({ 'a.tex': 'B' }), { message: 'device 2', lastSha: a.commit });
    const c = await pushBackup(client, repo, 'main', files({ 'a.tex': 'C' }), { message: 'device 1 again', lastSha: a.commit }); // stale lastSha but trailer present
    expect([b.diverged, c.diverged]).toEqual([false, false]);
    expect(r.files('main')['a.tex']).toBe('C');
  });

  it('parks the snapshot on the backup branch if the branch moves during the push', async () => {
    const r = gh.repo('octocat/paper', { empty: true });
    await pushBackup(client, repo, 'main', files({ 'a.tex': 'A' }), { message: 'm' });
    gh.failNextRefUpdate = true;
    const res = await pushBackup(client, repo, 'main', files({ 'a.tex': 'A2' }), { message: 'm' });
    expect(res.diverged).toBe(true);
    expect(res.branch).toBe(BACKUP_BRANCH);
    expect(r.files('main')['a.tex']).toBe('A');
  });

  it('creates the branch from the default branch when it does not exist', async () => {
    const r = gh.repo('octocat/paper', { empty: true });
    await pushBackup(client, repo, 'main', files({ 'a.tex': 'A' }), { message: 'm' });
    const res = await pushBackup(client, repo, 'drafts', files({ 'a.tex': 'D' }), { message: 'm' });
    expect(res.branch).toBe('drafts');
    expect(r.files('drafts')['a.tex']).toBe('D');
    expect(r.files('main')['a.tex']).toBe('A');
  });
});

describe('GitHub import (10.6 groundwork)', () => {
  it('round trips a backup, skipping bookkeeping files', async () => {
    gh.repo('octocat/paper', { empty: true });
    const src = files({ 'main.tex': 'hello', 'img/x.png': 'bin', 'sections/s.tex': '\\section{S}' });
    await pushBackup(client, repo, 'main', src, { message: 'm' });
    const got = await importRepo(client, repo, 'main');
    expect([...got.keys()].sort()).toEqual(['img/x.png', 'main.tex', 'sections/s.tex']);
    expect(new TextDecoder().decode(got.get('main.tex'))).toBe('hello');
  });
  it('rejects missing branches', async () => {
    gh.repo('octocat/paper', { empty: true });
    await pushBackup(client, repo, 'main', files({ 'a.tex': 'A' }), { message: 'm' });
    await expect(importRepo(client, repo, 'nope')).rejects.toThrow(/not found/);
  });
});

describe('repositories from before the rename (p2platex)', () => {
  it('treats old backup commits as its own, reads the old manifest and replaces it', async () => {
    const r = gh.repo('octocat/paper', { empty: true });
    // a backup made under the previous name
    gh.foreignCommit(
      'octocat/paper',
      'main',
      { 'a.tex': 'A', 'old.tex': 'O', '.p2platex.json': JSON.stringify({ version: 2, paths: ['a.tex', 'old.tex'] }) },
      'backup\n\nX-P2platex-Backup: 1',
    );
    const res = await pushBackup(client, repo, 'main', files({ 'a.tex': 'A2' }), { message: 'm', lastSha: 'an-older-backup' });
    expect(res.branch).toBe('main'); // not diverted to hivetex/backup
    const state = r.files('main');
    expect(state['old.tex']).toBeUndefined(); // deletion mirrored using the old manifest's paths
    expect(state['.p2platex.json']).toBeUndefined();
    expect(JSON.parse(state['.hivetex.json'] as string).paths).toEqual(['a.tex']);
  });

  it('never imports the old bookkeeping files', async () => {
    gh.repo('octocat/paper', { empty: true });
    gh.foreignCommit('octocat/paper', 'main', { 'main.tex': 'x', '.p2platex.json': '{}', '.p2platex': 'managed', '.hivetex.json': '{}' });
    const got = await importRepo(client, repo, 'main');
    expect([...got.keys()]).toEqual(['main.tex']);
  });
});
