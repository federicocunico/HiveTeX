/** Shared CI production delivery. No dependencies; safe to copy before checking out a release. */
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const stableVersion = tag => STABLE.test(tag || '');
export function compareVersions(a, b) {
  if (!stableVersion(a) || !stableVersion(b)) throw new Error('Expected stable version tags');
  const x = a.slice(1).split('.').map(BigInt), y = b.slice(1).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (x[i] > y[i]) return 1; if (x[i] < y[i]) return -1; }
  return 0;
}
export function releaseCanDeploy(release, tag) {
  return !!release && stableVersion(tag) && release.tag_name === tag && !release.draft && !release.prerelease;
}
export function trustedCI(runs, sha, repo) {
  return runs.filter(r => r.head_sha === sha && r.event === 'push' && r.head_repository?.full_name === repo);
}
export async function resolveTag(tag, repo, gh) {
  if (!stableVersion(tag)) throw new Error('Production requires a stable v<major>.<minor>.<patch> tag');
  let object = (await gh('/repos/' + repo + '/git/ref/tags/' + encodeURIComponent(tag))).object;
  for (let i = 0; object?.type === 'tag' && i < 8; i++) object = (await gh('/repos/' + repo + '/git/tags/' + object.sha)).object;
  if (object?.type !== 'commit' || !SHA.test(object.sha)) throw new Error('Release tag does not identify a commit');
  return object.sha;
}
export async function waitForCI(sha, repo, gh, sleep) {
  const cutoff = Date.now() + 15 * 60_000;
  for (let i = 0; i < 60; i++) {
    if (Date.now() >= cutoff) break;
    const response = await gh('/repos/' + repo + '/actions/workflows/ci.yml/runs?head_sha=' + sha + '&per_page=100', { signal: AbortSignal.timeout(Math.max(1, cutoff - Date.now())) });
    const runs = trustedCI(response.workflow_runs || [], sha, repo);
    if (runs.some(r => r.status === 'completed' && r.conclusion === 'success')) return;
    if (!runs.some(r => r.status !== 'completed')) throw new Error('No successful trusted push CI for ' + sha + '. Run CI for this commit, then retry Deploy.');
    if (i !== 59) await sleep(Math.max(0, Math.min(15_000, cutoff - Date.now())));
  }
  throw new Error('CI did not succeed within 15 minutes for ' + sha + '. Retry Deploy after CI succeeds.');
}
export async function prepare(options, deps) {
  const { repo, tag, sourceSHA, expectedSHA } = options;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('A repository in owner/name form is required');
  let sha = sourceSHA;
  if (tag) {
    const release = await deps.gh('/repos/' + repo + '/releases/tags/' + encodeURIComponent(tag));
    if (!releaseCanDeploy(release, tag)) throw new Error('Drafts and prereleases cannot deploy production');
    sha = await resolveTag(tag, repo, deps.gh);
    if (sourceSHA && sourceSHA !== sha) throw new Error('Recorded source does not match the release tag');
  }
  if (!SHA.test(sha || '')) throw new Error('A full immutable source SHA is required');
  if (expectedSHA && sha !== expectedSHA) throw new Error('Release tag/source changed since preparation; refusing deployment');
  await waitForCI(sha, repo, deps.gh, deps.sleep);
  return { ...options, sha };
}
export async function publishedStableTags(repo, gh) {
  const tags = [];
  for (let page = 1; page <= 20; page++) {
    const releases = await gh('/repos/' + repo + '/releases?per_page=100&page=' + page);
    for (const release of releases) if (releaseCanDeploy(release, release.tag_name)) tags.push(release.tag_name);
    if (releases.length < 100) return tags;
  }
  throw new Error('Release history exceeded the safe pagination limit; cannot establish production ordering');
}
export async function guard(candidate, current, deps) {
  if (candidate.kind === 'master') {
    const tip = (await deps.gh('/repos/' + candidate.repo + '/git/ref/heads/master')).object.sha;
    if (tip !== candidate.sha) return { skip: true, reason: 'master advanced; its own CI deploys the newer commit' };
  }
  if (candidate.tag) {
    const newer = (await publishedStableTags(candidate.repo, deps.gh)).find(t => compareVersions(t, candidate.tag) > 0);
    if (newer) return { skip: true, reason: 'newer stable release ' + newer + ' is already published' };
  }
  if (!current) return { skip: false };
  if (current.projectId !== candidate.projectId) throw new Error('Production alias belongs to a different Vercel project');
  if (current.readyState !== 'READY') throw new Error('Current production deployment is not READY');
  const meta = current.meta || {};
  const deployedSHA = meta.hivetexSha || meta.githubCommitSha || current.gitSource?.sha || (candidate.baselineId === current.id ? candidate.baselineSHA : null);
  if (!SHA.test(deployedSHA || '')) throw new Error('Production source is unknown. Set HIVETEX_PRODUCTION_BASELINE_ID and HIVETEX_PRODUCTION_BASELINE_SHA to the verified current deployment, then retry.');
  if (deployedSHA === candidate.sha) {
    await deps.health('https://' + current.url);
    return { skip: true, reason: 'source is already verified in production' };
  }
  const comparison = await deps.gh('/repos/' + candidate.repo + '/compare/' + deployedSHA + '...' + candidate.sha);
  if (comparison.status === 'behind') return { skip: true, reason: 'production already contains a newer descendant' };
  if (comparison.status !== 'ahead') throw new Error('Production and candidate sources diverge or cannot be ordered; investigate before deploying');
  return { skip: false };
}
export async function currentProduction(candidate, deps) {
  const alias = await deps.vercel('/v4/aliases/' + encodeURIComponent(candidate.siteHost) + '?projectId=' + encodeURIComponent(candidate.projectId), true);
  if (!alias) return null;
  if (alias.projectId !== candidate.projectId) throw new Error('Production alias project does not match the configured Vercel project');
  const id = alias.deploymentId || alias.deployment?.id;
  if (!id) throw new Error('Production alias did not identify a deployment');
  return deps.vercel('/v13/deployments/' + encodeURIComponent(id));
}
export function deploymentURL(stdout) {
  const url = stdout.split(/\r?\n/).map(s => s.trim()).filter(s => /^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/i.test(s)).at(-1);
  if (!url) throw new Error('Vercel did not return a unique deployment URL');
  return url.replace(/\/$/, '');
}
export async function waitReady(url, deps, projectId) {
  const host = new URL(url).hostname;
  for (let i = 0; i < 120; i++) {
    const deployment = await deps.vercel('/v13/deployments/' + encodeURIComponent(host));
    if (deployment.projectId !== projectId) throw new Error('Uploaded deployment belongs to a different project');
    if (deployment.readyState === 'READY') return deployment;
    if (['ERROR', 'CANCELED'].includes(deployment.readyState)) throw new Error('New Vercel build/migration failed: ' + deployment.readyState);
    await deps.sleep(5_000);
  }
  throw new Error('New Vercel deployment did not become READY within ten minutes');
}
async function retryCLI(args, deps) {
  for (let i = 0; i < 4; i++) {
    try { return await deps.cli(args); }
    catch (error) {
      deps.log(error.message);
      if (i === 3) throw new Error('Vercel command failed after four attempts; see build/upload logs above');
      await deps.sleep(60_000 * (i + 1));
    }
  }
}
export async function deploy(options, deps) {
  for (const name of ['token', 'orgId', 'projectId']) if (!options[name]) throw new Error('Missing Vercel setting ' + name + '. Run make setup.');
  const candidate = await prepare(options, deps);
  if ((await deps.head()).trim() !== candidate.sha) throw new Error('Checkout is not the verified source commit');
  let current = await currentProduction(candidate, deps);
  let decision = await guard(candidate, current, deps);
  if (decision.skip) return { outcome: 'skipped', ...decision, sha: candidate.sha, tag: candidate.tag, url: current ? 'https://' + current.url : '', id: current?.id };
  const args = ['deploy', '--prod', '--skip-domain', '--yes', '--token', options.token, '--meta', 'hivetexSha=' + candidate.sha, '--meta', 'hivetexTrigger=' + candidate.kind];
  if (candidate.tag) args.push('--meta', 'hivetexTag=' + candidate.tag);
  const result = await retryCLI(args, deps);
  const url = deploymentURL(result.stdout);
  const created = await waitReady(url, deps, candidate.projectId);
  if (created.meta?.hivetexSha !== candidate.sha) throw new Error('New deployment source metadata does not match the release');
  await deps.health(url);
  // The tag, CI and production state may change during the build; recheck before promotion.
  await prepare({ ...candidate, expectedSHA: candidate.sha }, deps);
  current = await currentProduction(candidate, deps);
  decision = await guard(candidate, current, deps);
  if (decision.skip) return { outcome: 'skipped', ...decision, sha: candidate.sha, tag: candidate.tag, url: current ? 'https://' + current.url : '', id: current?.id, stagedURL: url };
  await retryCLI(['promote', url, '--yes', '--token', options.token], deps);
  let aliased = false;
  for (let i = 0; i < 24; i++) {
    const alias = await deps.vercel('/v4/aliases/' + encodeURIComponent(candidate.siteHost) + '?projectId=' + encodeURIComponent(candidate.projectId), true);
    if (alias?.projectId === candidate.projectId && (alias.deploymentId || alias.deployment?.id) === created.id) { aliased = true; break; }
    await deps.sleep(5_000);
  }
  if (!aliased) throw new Error('Production alias still points at another deployment; old health is not success');
  await deps.health('https://' + candidate.siteHost);
  return { outcome: 'success', sha: candidate.sha, tag: candidate.tag, url, id: created.id };
}
export function optionsFromEnv(env) {
  const site = new URL(env.SITE || 'https://hivetex.vercel.app');
  if (site.protocol !== 'https:') throw new Error('Production SITE must use https');
  return { repo: env.GITHUB_REPOSITORY, tag: env.RELEASE_TAG || '', sourceSHA: env.SOURCE_SHA || (env.RELEASE_TAG ? '' : env.GITHUB_SHA), expectedSHA: env.EXPECTED_SOURCE_SHA || '', kind: env.TRIGGER_KIND || 'manual', token: env.VERCEL_TOKEN, orgId: env.VERCEL_ORG_ID, projectId: env.VERCEL_PROJECT_ID, siteHost: site.hostname, baselineId: env.HIVETEX_PRODUCTION_BASELINE_ID, baselineSHA: env.HIVETEX_PRODUCTION_BASELINE_SHA };
}
function dependencies(options, env) {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error('Production deployment exceeded its 40-minute budget')), 40 * 60_000);
  deadline.unref();
  const redact = text => [env.VERCEL_TOKEN, env.GH_TOKEN, env.VERCEL_AUTOMATION_BYPASS_SECRET].filter(Boolean).reduce((s, secret) => s.replaceAll(secret, '[redacted]'), String(text));
  async function json(url, token, allow404 = false, signal) {
    const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000), signal].filter(Boolean)) });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error('Remote API request failed: HTTP ' + response.status);
    return response.json();
  }
  return {
    gh: (path, request = {}) => json('https://api.github.com' + path, env.GH_TOKEN, false, request.signal),
    vercel: (path, allow404) => json('https://api.vercel.com' + path + (path.includes('?') ? '&' : '?') + 'teamId=' + encodeURIComponent(options.orgId), options.token, allow404),
    sleep: ms => new Promise((resolve, reject) => {
      if (abort.signal.aborted) return reject(abort.signal.reason);
      const timer = setTimeout(() => { abort.signal.removeEventListener('abort', stop); resolve(); }, ms);
      const stop = () => { clearTimeout(timer); reject(abort.signal.reason); };
      abort.signal.addEventListener('abort', stop, { once: true });
    }),
    log: message => console.error(redact(message)),
    head: async () => (await exec('git', ['rev-parse', 'HEAD'])).stdout,
    cli: async args => {
      try { return await exec('npx', ['--yes', 'vercel@latest', ...args], { timeout: 25 * 60_000, signal: abort.signal, maxBuffer: 8 * 1024 * 1024, windowsHide: true }); }
      catch (error) { throw new Error(redact((error.stderr || error.stdout || 'Vercel failed').slice(-10000))); }
    },
    health: async url => {
      const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET;
      const headers = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
      // Deployment Protection answers with 401/403 or a redirect to Vercel's SSO page.
      const isProtected = response => response.status === 401 || response.status === 403
        || (response.status >= 300 && response.status < 400 && /^https:\/\/vercel\.com\/sso-api/.test(response.headers.get('location') ?? ''));
      for (let i = 0; i < 24; i++) {
        try {
          const response = await fetch(url + '/api/health', { headers, redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]) });
          if (isProtected(response)) {
            if (bypass) throw new Error('Health check is protected and VERCEL_AUTOMATION_BYPASS_SECRET was rejected.');
            // Without a bypass secret, the Vercel CLI authenticates with the deploy token; protection stays enabled.
            const { stdout } = await exec('npx', ['--yes', 'vercel@latest', 'curl', url + '/api/health', '--yes', ...(options.token ? ['--token', options.token] : []), '--', '--silent', '--show-error', '--fail', '--max-time', '10'],
              { timeout: 120_000, signal: abort.signal, windowsHide: true });
            if (JSON.parse(stdout.trim().split('\n').at(-1)).ok === true) return;
          } else if (response.ok && (await response.json()).ok === true) return;
        } catch (error) {
          if (abort.signal.aborted || error.message.includes('Health check is protected')) throw error;
          if (i % 6 === 0 || i === 23) console.error(redact(`Health attempt ${i + 1} for ${url}: ${(error.stderr || error.message || String(error)).slice(-1500)}`));
        }
        if (i !== 23) await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { abort.signal.removeEventListener('abort', stop); resolve(); }, 5_000);
          const stop = () => { clearTimeout(timer); reject(abort.signal.reason); };
          abort.signal.addEventListener('abort', stop, { once: true });
        });
      }
      throw new Error('Health check failed for the intended deployment: ' + url);
    },
  };
}
async function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = optionsFromEnv(process.env);
    const deps = dependencies(options, process.env);
    if (process.argv[2] === 'prepare') {
      const candidate = await prepare(options, deps);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'sha=' + candidate.sha + '\n');
      await summary('Verified source ' + candidate.sha + (candidate.tag ? ' for ' + candidate.tag : ''));
    } else {
      const result = await deploy(options, deps);
      await summary('Production ' + result.outcome + ': ' + (result.tag || result.sha) + '\nSource: ' + result.sha + '\nDeployment: ' + (result.id || '(none)') + ' ' + result.url + (result.reason ? '\nReason: ' + result.reason : ''));
    }
  } catch (error) {
    const retry = options?.tag ? 'gh workflow run deploy.yml -f release_tag=' + options.tag : 'gh workflow run deploy.yml';
    await summary('Production failed for ' + (options?.tag || options?.sourceSHA || 'unresolved source') + ': ' + error.message + '\nAfter fixing the cause, retry: ' + retry + '\nPublished installers are kept.');
    process.exitCode = 1;
  }
}
