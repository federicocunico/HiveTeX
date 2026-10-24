import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('concurrent preparations own private staging, publish one complete set and clean only their own scratch', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hivetex-distribution-test-'));
  if (dirname(resolve(temporary)) !== resolve(tmpdir())) throw new Error('Unexpected test root');
  const archiveName = `hivetex-test-${randomUUID()}.tar`;
  const cachedArchive = join(tmpdir(), 'hivetex-texlive-2019', archiveName);
  const responses: ServerResponse[] = [];
  const server = createServer((_req, response) => {
    responses.push(response);
    // Both invocations must be in progress before allowing either one to publish.
    if (responses.length === 2) responses[0]!.end(archive);
  });
  let archive: Buffer;
  let attempts: Promise<void>[] = [];
  try {
    const maps = join(temporary, 'maps');
    await mkdir(maps);
    for (const name of ['cm.map', 'cmextra.map', 'latxfont.map', 'symbols.map', 'cm-super-ts1.map']) await writeFile(join(maps, name), `${name}\n`);
    const archivePath = join(temporary, archiveName);
    const tar = spawnSync('tar', ['-cf', archivePath, '-C', maps, '.'], { windowsHide: true, encoding: 'utf8' });
    expect(tar.status, tar.error?.message ?? tar.stderr).toBe(0);
    archive = await readFile(archivePath);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    const scripts = join(temporary, 'scripts');
    await mkdir(scripts);
    for (const name of ['tex-distribution.mjs', 'tex-resource-adapter.js']) await copyFile(fileURLToPath(new URL(`../../../scripts/${name}`, import.meta.url)), join(scripts, name));
    await writeFile(join(scripts, 'tex-distribution.lock.json'), JSON.stringify({
      engines: {}, formats: {}, archiveBase: `http://127.0.0.1:${port}/`,
      archives: [{ name: archiveName, sha256: createHash('sha256').update(archive).digest('hex'), kind: 'runtime' }],
    }));
    const generator = await import(/* @vite-ignore */ pathToFileURL(join(scripts, 'tex-distribution.mjs')).href);
    attempts = [generator.prepareTexDistribution(), generator.prepareTexDistribution()];
    const winner = await Promise.race(attempts.map((attempt, index) => attempt.then(() => index)));
    const web = join(temporary, 'apps/web');
    const active = (await readdir(web)).filter(name => name.startsWith('.texlive-staging-'));
    expect(active).toHaveLength(1);
    const publicEntries = await readdir(join(web, 'public/texlive'));
    expect(publicEntries).toEqual([generator.distributionId]);
    const manifest = JSON.parse(await readFile(join(web, 'public/texlive', generator.distributionId, 'manifest.json'), 'utf8'));
    expect(Object.keys(manifest.files)).toHaveLength(6);
    // The ready-output path must also leave the slower publisher alone.
    await generator.prepareTexDistribution();
    expect(await access(join(web, active[0]!)).then(() => true, () => false)).toBe(true);
    responses[1]!.end(archive);
    await attempts[1 - winner];
    expect((await readdir(web)).filter(name => name.startsWith('.texlive-staging-'))).toEqual([]);
    expect(await readdir(join(web, 'public/texlive'))).toEqual([generator.distributionId]);
  } finally {
    for (const response of responses) response.destroy();
    await Promise.allSettled(attempts);
    await new Promise<void>(done => server.close(() => done()));
    await rm(cachedArchive, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});
