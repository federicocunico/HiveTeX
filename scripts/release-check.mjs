#!/usr/bin/env node
/**
 * Before `make release` tags HEAD: the commit must be on GitHub, and its CI and Desktop runs must have passed.
 * The tag's own build then only makes the installers (it does not wait for the tests), so a flaky test or a package
 * mirror outage can never block a release. FORCE=1 skips this check (for example to re-tag after an infra failure).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (process.env.FORCE === '1') {
  console.log('FORCE=1: not checking CI for this commit.');
  process.exit(0);
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const gh = ['gh', 'C:/Program Files/GitHub CLI/gh.exe'].find((g) => spawnSync(g, ['--version']).status === 0 || (g.includes('/') && existsSync(g)));

const sha = process.env.RELEASE_SHA || sh('git', ['rev-parse', 'HEAD']); // RELEASE_SHA: check another commit
spawnSync('git', ['fetch', '--quiet', 'origin'], { stdio: 'ignore' });
const pushed = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/HEAD']).status === 0 || spawnSync('git', ['branch', '-r', '--contains', sha], { encoding: 'utf8' }).stdout.trim() !== '';
if (!pushed) {
  console.error(`Commit ${sha.slice(0, 7)} is not on GitHub yet: push it, wait for CI and Desktop to pass, then release.`);
  process.exit(1);
}

let runs;
try {
  if (!gh) throw new Error('GitHub CLI is unavailable');
  runs = JSON.parse(sh(gh, ['run', 'list', '--commit', sha, '--json', 'name,status,conclusion,event', '--limit', '50']));
} catch {
  // Public Actions metadata needs no additional workflow permissions or CLI credentials.
  const remote = sh('git', ['remote', 'get-url', 'origin']);
  const repo = process.env.GITHUB_REPOSITORY || remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Cannot identify the GitHub repository for source checks');
  const results = await Promise.all(['ci.yml', 'desktop.yml'].map(async workflow => {
    const response = await fetch('https://api.github.com/repos/' + repo + '/actions/workflows/' + workflow + '/runs?head_sha=' + sha + '&per_page=100', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Public source-check metadata failed: HTTP ' + response.status);
    const body = await response.json();
    return body.workflow_runs.filter(run => run.head_sha === sha && run.head_repository?.full_name === repo);
  }));
  runs = results.flat();
}
const need = ['CI', 'Desktop'];
const problems = [];
for (const name of need) {
  const r = runs.filter((x) => x.name === name && x.event === 'push');
  if (r.length === 0) problems.push(`${name}: no run for this commit yet`);
  else if (r.some((x) => x.conclusion === 'success')) continue;
  else if (r.some((x) => x.status !== 'completed')) problems.push(`${name}: still running`);
  else problems.push(`${name}: ${r[0].conclusion}`);
}
if (problems.length) {
  console.error(`Not tagging ${sha.slice(0, 7)}: its checks have not all passed.\n  ${problems.join('\n  ')}\nWait for them (or fix the failure), then run make release again.`);
  process.exit(1);
}
console.log(`CI and Desktop passed for ${sha.slice(0, 7)}.`);
