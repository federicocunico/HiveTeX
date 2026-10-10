import { GitHubClient, GitHubError, type RepoRef, type TreeEntry, gitBlobSha } from './client.js';

export const BACKUP_TRAILER = 'X-HiveTeX-Backup: 1';
export const MANIFEST_PATH = '.hivetex.json';
/** Names used before the product was renamed (p2platex): recognised, never written. */
export const LEGACY_BACKUP_TRAILER = 'X-P2platex-Backup: 1';
export const LEGACY_MANIFEST_PATH = '.p2platex.json';
/** A commit made by the backup (under the current or the previous product name). */
export const isBackupCommit = (message: string) => message.includes(BACKUP_TRAILER) || message.includes(LEGACY_BACKUP_TRAILER);
export const BACKUP_BRANCH = 'hivetex/backup';
const MAX_BLOB = 50 * 1024 * 1024;

export interface PushOptions {
  message: string;
  /** Commit sha of this project's last successful backup (shared through the project). */
  lastSha?: string | null;
  backupBranch?: string;
  /** Project identity written into the marker, so a clone of the repository opens as this project. */
  project?: { id: string; slug: string };
}

export interface PushResult {
  noop: boolean;
  commit: string | null;
  branch: string;
  /** True when the bound branch had commits we did not make, so we pushed to the backup branch instead. */
  diverged: boolean;
  uploaded: number;
  deleted: number;
}

async function resolveHead(client: GitHubClient, repo: RepoRef, branch: string): Promise<{ sha: string | null; empty: boolean }> {
  try {
    const sha = await client.getRef(repo, branch);
    if (sha) return { sha, empty: false };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 409) return { sha: null, empty: true };
    throw e;
  }
  // 404 for the ref: either the branch is missing or the repository has no commits at all.
  const info = await client.repo(repo);
  const def = await client.getRef(repo, info.default_branch).catch(() => null);
  return { sha: null, empty: def === null };
}

/**
 * Commits the project's files to GitHub from this device using the Git Data API. Only blobs whose git id
 * differs from the remote tree are uploaded. Never force-pushes: if the bound branch moved ahead with
 * foreign commits, the snapshot goes to `hivetex/backup` instead.
 */
export async function pushBackup(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
  files: Map<string, Uint8Array>,
  opts: PushOptions,
): Promise<PushResult> {
  const backupBranch = opts.backupBranch ?? BACKUP_BRANCH;
  let { sha: head, empty } = await resolveHead(client, repo, branch);
  if (empty) {
    await client.seedEmptyRepo(repo, branch);
    head = await client.getRef(repo, branch);
  }
  if (!head) {
    // Branch does not exist yet: start it from the default branch.
    const info = await client.repo(repo);
    head = await client.getRef(repo, info.default_branch);
    if (head) await client.createRef(repo, branch, head);
  }
  if (!head) throw new GitHubError(409, 'Cannot find a base commit to build on');

  let target = branch;
  let diverged = false;
  let base = head;
  const headCommit = await client.getCommit(repo, head);
  if (opts.lastSha && head !== opts.lastSha && !isBackupCommit(headCommit.message)) {
    // Someone pushed foreign commits since our last backup: do not touch the bound branch's history.
    diverged = true;
    target = backupBranch;
    const bb = await client.getRef(repo, backupBranch).catch(() => null);
    base = bb ?? head;
  }
  const baseCommit = base === head ? headCommit : await client.getCommit(repo, base);

  const remote = new Map<string, string>();
  for (const e of (await client.getTree(repo, baseCommit.tree.sha)).tree) if (e.type === 'blob') remote.set(e.path, e.sha);

  // Paths we managed in earlier backups (so deletions in the project are mirrored, but foreign files stay).
  let previous: string[] = [];
  const manifestSha = remote.get(MANIFEST_PATH) ?? remote.get(LEGACY_MANIFEST_PATH);
  if (manifestSha) {
    try {
      previous = (JSON.parse(new TextDecoder().decode(await client.getBlob(repo, manifestSha))) as { paths: string[] }).paths ?? [];
    } catch {
      previous = [];
    }
  }

  const entries: TreeEntry[] = [];
  let uploaded = 0;
  for (const [path, bytes] of files) {
    if (bytes.length > MAX_BLOB) continue;
    const sha = await gitBlobSha(bytes);
    if (remote.get(path) === sha) continue;
    const created = await client.createBlob(repo, bytes);
    uploaded++;
    entries.push({ path, mode: '100644', type: 'blob', sha: created });
  }
  let deleted = 0;
  for (const p of previous) {
    if (!files.has(p) && remote.has(p)) {
      entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
      deleted++;
    }
  }
  const manifest = new TextEncoder().encode(`${JSON.stringify({ version: 2, ...(opts.project ? { project: opts.project } : {}), paths: [...files.keys()].sort() }, null, 2)}\n`);
  if (remote.get(MANIFEST_PATH) !== (await gitBlobSha(manifest))) {
    entries.push({ path: MANIFEST_PATH, mode: '100644', type: 'blob', sha: await client.createBlob(repo, manifest) });
  }
  // The manifest from before the rename is replaced by the one above.
  if (remote.has(LEGACY_MANIFEST_PATH)) entries.push({ path: LEGACY_MANIFEST_PATH, mode: '100644', type: 'blob', sha: null });
  const contentChanged = uploaded > 0 || deleted > 0;
  if (!contentChanged) return { noop: true, commit: null, branch: target, diverged, uploaded: 0, deleted: 0 };

  const tree = await client.createTree(repo, baseCommit.tree.sha, entries);
  const commit = await client.createCommit(repo, `${opts.message}\n\n${BACKUP_TRAILER}`, tree, [base]);
  try {
    if (target === backupBranch && !(await client.getRef(repo, backupBranch).catch(() => null))) await client.createRef(repo, backupBranch, commit);
    else await client.updateRef(repo, target, commit);
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 422 || e.status === 409) && target !== backupBranch) {
      // The branch moved while we were preparing: park the snapshot on the backup branch.
      const bb = await client.getRef(repo, backupBranch).catch(() => null);
      if (bb) await client.updateRef(repo, backupBranch, commit);
      else await client.createRef(repo, backupBranch, commit);
      return { noop: false, commit, branch: backupBranch, diverged: true, uploaded, deleted };
    }
    throw e;
  }
  return { noop: false, commit, branch: target, diverged, uploaded, deleted };
}

/** Downloads every file of a branch (except HiveTeX bookkeeping) for bootstrap/import. */
export async function importRepo(
  client: GitHubClient,
  repo: RepoRef,
  branch: string,
  opts: { concurrency?: number; maxFiles?: number } = {},
): Promise<Map<string, Uint8Array>> {
  const head = await client.getRef(repo, branch);
  if (!head) throw new GitHubError(404, `Branch ${branch} not found`);
  const commit = await client.getCommit(repo, head);
  const tree = await client.getTree(repo, commit.tree.sha);
  const wanted = tree.tree.filter((e) => e.type === 'blob' && ![MANIFEST_PATH, LEGACY_MANIFEST_PATH, '.hivetex', '.p2platex'].includes(e.path) && !e.path.startsWith('.git/'));
  if (wanted.length > (opts.maxFiles ?? 5000)) throw new GitHubError(413, 'Repository has too many files to import');
  const out = new Map<string, Uint8Array>();
  let i = 0;
  const worker = async () => {
    for (;;) {
      const e = wanted[i++];
      if (!e) return;
      out.set(e.path, await client.getBlob(repo, e.sha));
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  return out;
}
