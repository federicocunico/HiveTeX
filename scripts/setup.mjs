#!/usr/bin/env node
/**
 * One-command setup of a test deployment (`make setup`). Safe to re-run: every step checks what exists first.
 *
 *   1 tools and logins (gh, Vercel)     5 deploy to production (migrations run in the Vercel build)
 *   2 link the Vercel project           6 health check
 *   3 Neon + Upstash (Marketplace)      7 GitHub secret: updater signing key
 *   4 server settings in Vercel         8 GitHub variable: server URL for the installers
 *
 * Values that cannot be generated (Gmail account + App Password, first admin, optional TURN keys) come from the
 * environment, then from a git-ignored `.env.setup` file, then from a prompt. Secret values are passed to the CLIs on
 * stdin and never printed.
 *
 * Options: --only=secrets (ticket keys + updater key), --dry-run (show what would change), ROTATE=1 (new ticket keys).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { generateTicketKeys } from './gen-secrets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const onlySecrets = args.has('--only=secrets');
const dryRun = args.has('--dry-run') || process.env.DRY_RUN === '1';
const rotate = process.env.ROTATE === '1';
const TARGETS = ['production', 'preview'];

// ---------- inputs ----------

const fileVars = {};
const setupFile = join(root, '.env.setup');
if (existsSync(setupFile)) {
  for (const line of readFileSync(setupFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) fileVars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const given = (name) => process.env[name] || fileVars[name] || '';

async function ask(question, { secret = false, optional = false } = {}) {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (secret) {
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => write(s.startsWith(question) ? s : s.replace(/[^\r\n]/g, '*'));
  }
  const answer = await new Promise((resolve) => rl.question(`${question}${optional ? ' (Enter to skip)' : ''}: `, resolve));
  rl.close();
  if (secret) process.stdout.write('\n');
  return answer.trim();
}

/** A value from env / .env.setup, else a prompt. `explicit` tells whether the maintainer passed it (then it overwrites). */
async function input(name, question, opts = {}) {
  const v = given(name);
  if (v) return { value: v, explicit: true };
  return { value: await ask(question, opts), explicit: false };
}

// ---------- command runners (no shell: values are never interpreted, secrets go through stdin) ----------

function npxCli() {
  const dir = dirname(process.execPath);
  for (const c of [join(dir, 'node_modules/npm/bin/npx-cli.js'), join(dir, '../lib/node_modules/npm/bin/npx-cli.js')]) if (existsSync(c)) return c;
  return null;
}
const NPX = npxCli();

function run(cmd, cmdArgs, { input: stdin, capture = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: root,
    input: stdin,
    encoding: 'utf8',
    stdio: [stdin === undefined ? (capture ? 'ignore' : 'inherit') : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    shell: false,
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    const tail = capture ? `\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-5).join('\n')}` : '';
    throw new Error(`\`${cmd === process.execPath ? 'vercel' : cmd} ${cmdArgs.filter((a) => !a.endsWith('npx-cli.js') && a !== '--yes' && !a.startsWith('vercel@')).slice(0, 3).join(' ')}\` failed${tail}`);
  }
  return r;
}
const vercel = (a, o) => (NPX ? run(process.execPath, [NPX, '--yes', 'vercel@latest', ...a], o) : run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'vercel@latest', ...a], o));
const gh = (a, o) => run('gh', a, o);
const json = (text) => {
  const i = text.indexOf('{');
  return i < 0 ? {} : JSON.parse(text.slice(i));
};

// ---------- output ----------

let stepNo = 0;
const total = onlySecrets ? 3 : 8;
const step = (title) => console.log(`\n[${++stepNo}/${total}] ${title}`);
const note = (s) => console.log(`      ${s}`);
const change = (s) => console.log(`      ${dryRun ? 'would ' : ''}${s}`);

// ---------- steps ----------

function toolsAndLogins() {
  step('Tools and logins');
  if (spawnSync('gh', ['--version'], { encoding: 'utf8' }).error) throw new Error('GitHub CLI not found: install it from https://cli.github.com and run `gh auth login`.');
  if (run('gh', ['auth', 'status'], { capture: true, allowFail: true }).status !== 0) {
    if (dryRun) throw new Error('Not logged in to GitHub: run `gh auth login`.');
    gh(['auth', 'login']);
  }
  const who = vercel(['whoami'], { capture: true, allowFail: true });
  if (who.status !== 0) {
    if (dryRun) throw new Error('Not logged in to Vercel: run `npx vercel@latest login`.');
    vercel(['login']);
  }
  note(`GitHub and Vercel (${(vercel(['whoami'], { capture: true }).stdout || '').trim().split('\n').pop()}) ready`);
}

function linkProject() {
  step('Vercel project');
  const linked = join(root, '.vercel/project.json');
  if (existsSync(linked)) {
    note(`linked to ${JSON.parse(readFileSync(linked, 'utf8')).projectName ?? 'a project'}`);
    return;
  }
  const name = given('VERCEL_PROJECT') || 'hivetex';
  change(`link (creating if needed) project ${name}`);
  if (!dryRun) vercel(['link', '--yes', '--project', name]);
}

function storage() {
  step('Database (Neon) and Redis (Upstash)');
  const resources = json(vercel(['integration', 'list', '--format', 'json'], { capture: true }).stdout).resources ?? [];
  const has = (re) => resources.some((r) => re.test(r.product ?? '') && r.status === 'available');
  for (const [label, re, add] of [
    ['Neon', /neon/i, ['integration', 'add', 'neon', '-m', 'region=iad1']],
    ['Upstash Redis', /upstash.*redis|redis/i, ['integration', 'add', 'upstash/upstash-kv', '-m', 'primaryRegion=iad1']],
  ]) {
    if (has(re)) note(`${label}: present`);
    else {
      change(`add ${label} (free plan; the CLI may ask you to accept the provider's terms once)`);
      if (!dryRun) vercel(add);
    }
  }
}

function existingNames() {
  const names = {};
  for (const t of TARGETS) {
    const envs = json(vercel(['env', 'ls', t, '--format', 'json'], { capture: true }).stdout).envs ?? [];
    names[t] = new Set(envs.map((e) => e.key));
  }
  return names;
}

/** Stores NAME=value for production and preview. Existing values are kept unless `overwrite`. */
function setEnv(existing, name, value, { overwrite = false, secret = true } = {}) {
  for (const t of TARGETS) {
    const present = existing[t].has(name);
    if (present && !overwrite) {
      note(`${name} (${t}): kept`);
      continue;
    }
    change(`${present ? 'replace' : 'set'} ${name} (${t})${secret ? '' : ` = ${value}`}`);
    if (!dryRun) vercel(['env', 'add', name, t, ...(present ? ['--force'] : [])], { input: value, capture: true });
  }
}

async function serverSettings({ ticketsOnly = false } = {}) {
  step(ticketsOnly ? 'Ticket signing keys (Vercel)' : 'Server settings (Vercel)');
  const existing = existingNames();
  const haveKeys = TARGETS.every((t) => existing[t].has('TICKET_SIGNING_JWK') && existing[t].has('TICKET_PUBLIC_JWKS'));
  if (haveKeys && !rotate) note('ticket keys: kept (ROTATE=1 to replace)');
  else {
    const k = generateTicketKeys();
    setEnv(existing, 'TICKET_SIGNING_JWK', k.signingJwk, { overwrite: true });
    setEnv(existing, 'TICKET_PUBLIC_JWKS', k.publicJwks, { overwrite: true });
    setEnv(existing, 'TICKET_KID', k.kid, { overwrite: true, secret: false });
  }
  if (ticketsOnly) return;

  const missing = (n) => TARGETS.some((t) => !existing[t].has(n));
  const needed = [];
  const want = async (name, question, opts = {}) => {
    if (!missing(name) && !given(name)) return note(`${name}: kept`);
    const { value, explicit } = await input(name, question, opts);
    if (!value) return opts.optional ? note(`${name}: skipped`) : needed.push(name);
    setEnv(existing, name, value, { overwrite: explicit, secret: opts.secret !== false });
  };
  await want('GMAIL_USER', 'Gmail address that sends account emails', { secret: false });
  await want('GMAIL_APP_PASSWORD', 'Its App Password (https://myaccount.google.com/apppasswords)', { secret: true });
  await want('BOOTSTRAP_ADMIN', 'Username that becomes the first admin when it registers', { secret: false });
  if (missing('CF_TURN_KEY_ID') && !given('CF_TURN_KEY_ID')) note('TURN relay: optional, recommended for testers on different networks');
  await want('CF_TURN_KEY_ID', 'Cloudflare TURN key id', { secret: false, optional: true });
  if (given('CF_TURN_KEY_ID') || !missing('CF_TURN_KEY_ID')) await want('CF_TURN_API_TOKEN', 'Cloudflare TURN API token', { secret: true });
  if (needed.length) {
    throw new Error(`Missing values: ${needed.join(', ')}. Run in a terminal to be asked, or put them in .env.setup (see .env.example).`);
  }
}

function deploy() {
  step('Deploy to production (database migrations run in the build)');
  if (dryRun) {
    change('run `vercel deploy --prod`');
    return null;
  }
  const r = vercel(['deploy', '--prod', '--yes', '--format', 'json'], { capture: true });
  const urls = new Set();
  const collect = (o) => {
    if (typeof o === 'string') for (const m of o.matchAll(/(?:https:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app)/g)) urls.add(m[1]);
    else if (o && typeof o === 'object') for (const v of Object.values(o)) collect(v);
  };
  collect(json(r.stdout));
  const deployment = [...urls].sort((a, b) => b.length - a.length)[0];
  if (deployment) {
    // The deployment's aliases include the stable production domain (the shortest name).
    collect(json(vercel(['inspect', deployment, '--format', 'json'], { capture: true, allowFail: true }).stdout || '{}'));
  }
  const prod = [...urls].sort((a, b) => a.length - b.length)[0];
  if (!prod) throw new Error('Deployed, but could not read its URL from the Vercel CLI output. Check `npx vercel@latest ls`.');
  note(`deployed: https://${prod}`);
  return `https://${prod}`;
}

async function health(url) {
  step('Health check');
  if (!url) return change('check /api/health');
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return note(`${url}/api/health: ${res.status}`);
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${url}/api/health did not answer 200: see \`npx vercel@latest logs ${url.replace('https://', '')}\``);
}

function updaterKey() {
  step('GitHub secret: updater signing key');
  const list = gh(['secret', 'list'], { capture: true }).stdout ?? '';
  if (/^TAURI_SIGNING_PRIVATE_KEY\s/m.test(list)) return note('TAURI_SIGNING_PRIVATE_KEY: present');
  const keyFile = join(homedir(), '.tauri', 'p2platex.key');
  if (!existsSync(keyFile)) {
    note('no key at ~/.tauri/p2platex.key: generate one with `npx @tauri-apps/cli signer generate -w ~/.tauri/p2platex.key`,');
    note('put its public key in apps/desktop/src-tauri/tauri.conf.json (plugins.updater.pubkey), then re-run.');
    return;
  }
  change('set TAURI_SIGNING_PRIVATE_KEY from ~/.tauri/p2platex.key');
  if (!dryRun) gh(['secret', 'set', 'TAURI_SIGNING_PRIVATE_KEY'], { input: readFileSync(keyFile, 'utf8'), capture: true });
}

function serverVariable(url) {
  step('GitHub variable: default server for the installers');
  if (!url) return change('set P2PLATEX_API_BASE to the production URL');
  change(`set P2PLATEX_API_BASE = ${url}`);
  if (!dryRun) gh(['variable', 'set', 'P2PLATEX_API_BASE', '--body', url], { capture: true });
}

// ---------- main ----------

try {
  if (dryRun) console.log('Dry run: nothing will be changed.');
  toolsAndLogins();
  if (onlySecrets) {
    await serverSettings({ ticketsOnly: true });
    updaterKey();
  } else {
    linkProject();
    storage();
    await serverSettings();
    const url = deploy();
    await health(url);
    updaterKey();
    serverVariable(url);
    console.log(`\nDone.${url ? ` The app is at ${url}` : ''}`);
    const admin = given('BOOTSTRAP_ADMIN');
    console.log(`Next: register${admin ? ` "${admin}"` : ' the admin username you chose'} there (it becomes admin), then`);
    console.log('      make release VERSION=x.y.z CONFIRM=1   to build installers that use this server.');
  }
} catch (e) {
  console.error(`\nSetup stopped: ${e instanceof Error ? e.message : e}`);
  console.error('Fix the cause and run it again: completed steps are skipped.');
  process.exit(1);
}
