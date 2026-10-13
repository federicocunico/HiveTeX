import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compareVersions, deploy, deploymentURL, guard, prepare, releaseCanDeploy, resolveTag, stableVersion, waitForCI } from './deploy-production.mjs';
const A = 'a'.repeat(40), B = 'b'.repeat(40), T = 'c'.repeat(40);
const repo = 'owner/repo';
const successful = { head_sha: A, event: 'push', head_repository: { full_name: repo }, status: 'completed', conclusion: 'success' };
function fixture(overrides = {}) {
  const calls = { writes: [], health: [], sleep: [], gh: [], log: [] };
  let promoted = false, tagReads = 0;
  const options = { repo, tag: 'v1.2.3', sourceSHA: A, kind: 'release', token: 'test-token', orgId: 'team-test', projectId: 'prj_test', siteHost: 'site.vercel.app', ...overrides.options };
  const current = { id: 'dpl_old', projectId: 'prj_test', readyState: 'READY', url: 'old.vercel.app', meta: { hivetexSha: B }, ...overrides.current };
  const created = { id: 'dpl_new', projectId: 'prj_test', readyState: 'READY', url: 'new.vercel.app', meta: { hivetexSha: A }, target: 'production', gitSource: { sha: A }, ...overrides.created };
  const deps = {
    gh: async path => {
      calls.gh.push(path);
      if (path === '/repos/' + repo) return { id: 123 };
      if (path.includes('/releases/tags/')) return { tag_name: options.tag, draft: false, prerelease: false, ...overrides.release };
      if (path.includes('/git/ref/tags/')) return { object: { type: 'commit', sha: overrides.changedTag && ++tagReads > 1 ? B : A } };
      if (path.includes('/git/ref/heads/')) return { object: { sha: overrides.masterTip || A } };
      if (path.includes('/actions/workflows/ci.yml/')) return { workflow_runs: overrides.runs || [successful] };
      if (path.includes('/releases?')) return overrides.releases || [{ tag_name: options.tag, draft: false, prerelease: false }];
      if (path.includes('/compare/')) return { status: overrides.comparison || 'ahead' };
      throw new Error('Unexpected GitHub request ' + path);
    },
    vercel: async (path, allow404, body) => {
      if (body !== undefined) {
        calls.writes.push({ path, body });
        if (overrides.apiFailure) throw new Error('deployment request failed');
        if (path.includes('/promote/')) { promoted = true; return {}; }
        if (path === '/v13/deployments') return { id: 'dpl_new', url: 'new.vercel.app' };
        throw new Error('Unexpected API write ' + path);
      }
      if (path.includes('/v9/projects/')) return { id: 'prj_test', name: 'site' };

      if (path.includes('/v4/aliases/')) return { projectId: 'prj_test', deploymentId: promoted && !overrides.oldAlias ? 'dpl_new' : 'dpl_old' };
      if (path.includes('dpl_old')) return current;
      if (path.includes('dpl_new') || path.includes('new.vercel.app')) return created;
      throw new Error('Unexpected Vercel request ' + path);
    },
    head: async () => overrides.head || A,
    health: async url => { calls.health.push(url); if (overrides.unhealthyNew && url === 'https://new.vercel.app') throw new Error('new health failed'); },
    sleep: async ms => { calls.sleep.push(ms); },
    log: message => calls.log.push(message),
  };
  return { options, deps, calls, current, created };
}
test('stable release selection excludes prerelease/draft and invalid tags', () => {
  for (const tag of ['v1.2.3', 'v0.0.0', 'v100.20.3']) assert.equal(stableVersion(tag), true);
  for (const tag of ['v01.2.3', 'v1.2.3-beta', '1.2.3', 'v1.2', 'v1.2.3\n']) assert.equal(stableVersion(tag), false);
  assert.equal(releaseCanDeploy({ tag_name: 'v1.2.3', prerelease: true }, 'v1.2.3'), false);
  assert.equal(releaseCanDeploy({ tag_name: 'v1.2.3', draft: true }, 'v1.2.3'), false);
  assert.equal(compareVersions('v1.10.0', 'v1.9.99'), 1);
});
test('resolves both lightweight and annotated tags to an immutable commit', async () => {
  const light = async () => ({ object: { type: 'commit', sha: A } });
  assert.equal(await resolveTag('v1.2.3', repo, light), A);
  const annotated = async path => ({ object: path.includes('/git/ref/') ? { type: 'tag', sha: T } : { type: 'commit', sha: A } });
  assert.equal(await resolveTag('v1.2.3', repo, annotated), A);
});
test('CI accepts only exact-source trusted push runs and waits boundedly for active CI', async () => {
  for (const runs of [[{ ...successful, head_sha: B }], [{ ...successful, event: 'pull_request' }], [{ ...successful, head_repository: { full_name: 'fork/repo' } }], [{ ...successful, conclusion: 'failure' }], []]) {
    await assert.rejects(waitForCI(A, repo, async () => ({ workflow_runs: runs }), async () => {}), /No successful trusted push CI/);
  }
  let n = 0, waits = 0;
  await waitForCI(A, repo, async () => ({ workflow_runs: [{ ...successful, status: ++n === 1 ? 'in_progress' : 'completed' }] }), async () => waits++);
  assert.equal(waits, 1);
  let bounded = 0;
  await assert.rejects(waitForCI(A, repo, async () => ({ workflow_runs: [{ ...successful, status: 'queued' }] }), async () => bounded++), /15 minutes/);
  assert.equal(bounded, 59);
});
test('release preparation rejects changed source, drafts and prereleases', async () => {
  for (const release of [{ draft: true }, { prerelease: true }]) {
    const f = fixture({ release });
    await assert.rejects(prepare(f.options, f.deps), /Drafts and prereleases/);
  }
  const f = fixture({ options: { expectedSHA: B } });
  await assert.rejects(prepare(f.options, f.deps), /changed since preparation/);
});
test('uses the release commit when master advances and preserves explicit checkout verification', async () => {
  const f = fixture({ masterTip: B });
  const result = await deploy(f.options, f.deps);
  assert.equal(result.sha, A);
  assert.equal(result.outcome, 'success');
  assert.equal(f.calls.writes[0].body.autoAssignCustomDomains, false);
  assert.equal(f.calls.writes[0].body.meta.hivetexSha, A);
  assert.deepEqual(f.calls.writes[0].body.gitSource, { type: 'github', repoId: '123', ref: A, sha: A });
  assert.equal(f.calls.writes[0].body.target, 'production');
  assert.equal(f.calls.writes[1].path, '/v10/projects/prj_test/promote/dpl_new');
  assert.deepEqual(f.calls.health, ['https://new.vercel.app', 'https://site.vercel.app']);
  const wrong = fixture({ head: B });
  await assert.rejects(deploy(wrong.options, wrong.deps), /Checkout is not/);
  assert.equal(wrong.calls.writes.length, 0);
});
test('skips stale master, older stable release and an ancestor of deployed production', async () => {
  const master = fixture({ options: { tag: '', kind: 'master' }, masterTip: B });
  assert.equal((await deploy(master.options, master.deps)).outcome, 'skipped');
  const old = fixture({ releases: [{ tag_name: 'v2.0.0', draft: false, prerelease: false }] });
  assert.match((await deploy(old.options, old.deps)).reason, /newer stable release/);
  const ancestor = fixture({ comparison: 'behind' });
  assert.match((await deploy(ancestor.options, ancestor.deps)).reason, /newer descendant/);
  for (const f of [master, old, ancestor]) assert.equal(f.calls.writes.length, 0);
});
test('duplicate notifications verify the already-current source without uploading', async () => {
  const f = fixture({ current: { meta: { hivetexSha: A } } });
  assert.equal((await deploy(f.options, f.deps)).outcome, 'skipped');
  assert.equal(f.calls.writes.length, 0);
  assert.deepEqual(f.calls.health, ['https://old.vercel.app']);
});
test('legacy CLI git metadata establishes source ordering without bypassing project or SHA checks', async () => {
  const legacy = fixture({ current: { meta: { gitCommitSha: B } } });
  assert.equal((await deploy(legacy.options, legacy.deps)).outcome, 'success');
  assert.equal(legacy.calls.gh.some(path => path.endsWith('/compare/' + B + '...' + A)), true);
  const wrongProject = fixture({ current: { projectId: 'other-project', meta: { gitCommitSha: B } } });
  await assert.rejects(deploy(wrongProject.options, wrongProject.deps), /different Vercel project/);
  const invalid = fixture({ current: { meta: { gitCommitSha: 'invalid' } } });
  await assert.rejects(deploy(invalid.options, invalid.deps), /source is unknown/);
  assert.equal(invalid.calls.writes.length, 0);
});
test('unknown/divergent production fails and explicit baseline is bound to its deployment ID', async () => {
  const unknown = fixture({ current: { meta: {} } });
  await assert.rejects(deploy(unknown.options, unknown.deps), /source is unknown/);
  const divergent = fixture({ comparison: 'diverged' });
  await assert.rejects(deploy(divergent.options, divergent.deps), /diverge/);
  const baseline = fixture({ current: { meta: {} }, options: { baselineId: 'dpl_old', baselineSHA: B } });
  assert.equal((await deploy(baseline.options, baseline.deps)).outcome, 'success');
  const wrongBaseline = fixture({ current: { meta: {} }, options: { baselineId: 'dpl_other', baselineSHA: B } });
  await assert.rejects(deploy(wrongBaseline.options, wrongBaseline.deps), /source is unknown/);
});
test('build/migration and unhealthy new deployment failures never promote an old healthy endpoint', async () => {
  for (const overrides of [{ created: { readyState: 'ERROR' } }, { unhealthyNew: true }]) {
    const f = fixture(overrides);
    await assert.rejects(deploy(f.options, f.deps));
    assert.equal(f.calls.writes.some(c => c.path.includes('/promote/')), false);
    assert.equal(f.calls.health.includes('https://site.vercel.app'), false);
  }
});
test('API failures retry exactly four times and preserve published installers', async () => {
  const f = fixture({ apiFailure: true });
  await assert.rejects(deploy(f.options, f.deps), /four attempts/);
  assert.equal(f.calls.writes.length, 4);
  assert.deepEqual(f.calls.sleep, [60000, 120000, 180000]);
  assert.equal(f.calls.gh.some(p => p.includes('/assets')), false);
});
test('rechecks moved tags and production ordering after a staged build', async () => {
  const moved = fixture({ changedTag: true });
  await assert.rejects(deploy(moved.options, moved.deps), /does not match/);
  assert.equal(moved.calls.writes.some(c => c.path.includes('/promote/')), false);
  const newer = fixture();
  const gh = newer.deps.gh;
  let comparisons = 0;
  newer.deps.gh = async path => path.includes('/compare/') ? { status: ++comparisons === 1 ? 'ahead' : 'behind' } : gh(path);
  assert.equal((await deploy(newer.options, newer.deps)).outcome, 'skipped');
  assert.equal(newer.calls.writes.some(c => c.path.includes('/promote/')), false);
});
test('old production health cannot stand in for alias promotion', async () => {
  const f = fixture({ oldAlias: true });
  await assert.rejects(deploy(f.options, f.deps), /alias still points/);
  assert.equal(f.calls.health.includes('https://site.vercel.app'), false);
});
test('validates deployment source/project and unique URL independently of old production', async () => {
  const wrongGit = fixture({ created: { gitSource: { sha: B } } });
  await assert.rejects(deploy(wrongGit.options, wrongGit.deps), /Built Git source/);
  assert.equal(wrongGit.calls.writes.some(c => c.path.includes('/promote/')), false);
  const preview = fixture({ created: { target: 'preview' } });
  await assert.rejects(deploy(preview.options, preview.deps), /not built for production/);
  const wrongSHA = fixture({ created: { meta: { hivetexSha: B } } });
  await assert.rejects(deploy(wrongSHA.options, wrongSHA.deps), /metadata does not match/);
  const wrongProject = fixture({ created: { projectId: 'other' } });
  await assert.rejects(deploy(wrongProject.options, wrongProject.deps), /different project/);
  assert.equal(deploymentURL('log\nhttps://new.vercel.app\n'), 'https://new.vercel.app');
  assert.throws(() => deploymentURL('https://external.example'), /unique deployment URL/);
});
test('workflow handoff is direct, publication-gated, shares only the deploy job lock, and supports manual recovery', async () => {
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const deployWorkflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const reusable = await readFile(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
  assert.match(release, /needs: publish/);
  assert.match(release, /if: needs.publish.outputs.stable == 'true'/);
  assert.match(release, /uses: \.\/\.github\/workflows\/deploy-production.yml/);
  assert.match(release, /if: steps.publication.outputs.stable == 'true'/);
  assert.match(deployWorkflow, /release:\r?\n    types: \[published\]/);
  assert.match(deployWorkflow, /release_tag:/);
  assert.doesNotMatch(deployWorkflow, /group: deploy-production/);
  assert.match(reusable, /workflow_call:/);
  assert.match(reusable, /group: deploy-production/);
  assert.match(reusable, /EXPECTED_SOURCE_SHA:/);
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.git.deploymentEnabled, false);
});
