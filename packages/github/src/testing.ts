import { gitBlobSha } from './client.js';

/** In-memory GitHub Git Data API (the subset p2platex uses) for tests. */
export class FakeGitHub {
  repos = new Map<string, FakeRepo>();
  user = { login: 'octocat', id: 1 };
  readonly stats = { blobsCreated: 0, commits: 0, requests: 0, forcePushAttempts: 0 };
  /** Make the next ref update fail as non-fast-forward (simulates a race). */
  failNextRefUpdate = false;
  private counter = 0;

  repo(name: string, opts: { empty?: boolean } = {}) {
    let r = this.repos.get(name);
    if (!r) {
      r = new FakeRepo(opts.empty ?? false);
      this.repos.set(name, r);
    }
    return r;
  }

  readonly fetch = (async (input: string, init?: RequestInit) => {
    this.stats.requests++;
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const path = url.pathname;
    if (path === '/user') return json(200, this.user);
    if (path === '/user/repos' && method === 'POST') {
      this.repo(`${this.user.login}/${body.name}`, { empty: true });
      return json(201, { full_name: `${this.user.login}/${body.name}`, default_branch: 'main', owner: { login: this.user.login } });
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return json(404, { message: 'Not Found' });
    const repo = this.repos.get(`${m[1]}/${m[2]}`);
    if (!repo) return json(404, { message: 'Not Found' });
    const rest = m[3] ?? '';
    if (rest === '' && method === 'GET') return json(200, { default_branch: 'main', private: true, permissions: { push: true } });

    if (rest.startsWith('/git/ref/heads/') && method === 'GET') {
      if (repo.empty) return json(409, { message: 'Git Repository is empty.' });
      const sha = repo.refs.get(decodeURIComponent(rest.slice('/git/ref/heads/'.length)));
      return sha ? json(200, { object: { sha } }) : json(404, { message: 'Not Found' });
    }
    if (rest === '/git/refs' && method === 'POST') {
      repo.refs.set(String(body.ref).replace('refs/heads/', ''), body.sha);
      return json(201, { ref: body.ref });
    }
    if (rest.startsWith('/git/refs/heads/') && method === 'PATCH') {
      const branch = decodeURIComponent(rest.slice('/git/refs/heads/'.length));
      if (body.force) this.stats.forcePushAttempts++;
      const cur = repo.refs.get(branch);
      if (this.failNextRefUpdate) {
        this.failNextRefUpdate = false;
        return json(422, { message: 'Update is not a fast forward' });
      }
      if (cur && !repo.isAncestor(cur, body.sha)) return json(422, { message: 'Update is not a fast forward' });
      repo.refs.set(branch, body.sha);
      return json(200, { ref: `refs/heads/${branch}` });
    }
    if (rest.startsWith('/git/commits/') && method === 'GET') {
      const c = repo.commits.get(rest.slice('/git/commits/'.length));
      return c ? json(200, { sha: c.sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : json(404, { message: 'Not Found' });
    }
    if (rest === '/git/commits' && method === 'POST') {
      const sha = this.fakeSha('commit');
      repo.commits.set(sha, { sha, message: body.message, tree: body.tree, parents: body.parents });
      this.stats.commits++;
      return json(201, { sha });
    }
    if (rest.startsWith('/git/trees/') && method === 'GET') {
      const t = repo.trees.get(rest.slice('/git/trees/'.length));
      return t ? json(200, { tree: [...t].map(([p, sha]) => ({ path: p, type: 'blob', sha, mode: '100644' })), truncated: false }) : json(404, { message: 'Not Found' });
    }
    if (rest === '/git/trees' && method === 'POST') {
      const base = body.base_tree ? new Map(repo.trees.get(body.base_tree) ?? []) : new Map<string, string>();
      for (const e of body.tree as Array<{ path: string; sha: string | null }>) {
        if (e.sha === null) base.delete(e.path);
        else base.set(e.path, e.sha);
      }
      const sha = this.fakeSha('tree');
      repo.trees.set(sha, base);
      return json(201, { sha });
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const bytes = Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0));
      const sha = await gitBlobSha(bytes);
      repo.blobs.set(sha, bytes);
      this.stats.blobsCreated++;
      return json(201, { sha });
    }
    if (rest.startsWith('/git/blobs/') && method === 'GET') {
      const b = repo.blobs.get(rest.slice('/git/blobs/'.length));
      return b ? json(200, { content: btoa(String.fromCharCode(...b)), encoding: 'base64' }) : json(404, { message: 'Not Found' });
    }
    if (rest.startsWith('/contents/') && method === 'PUT') {
      // Seeds an empty repo with an initial commit on the requested branch.
      const bytes = Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0));
      const blob = await gitBlobSha(bytes);
      repo.blobs.set(blob, bytes);
      const treeSha = this.fakeSha('tree');
      repo.trees.set(treeSha, new Map([[rest.slice('/contents/'.length), blob]]));
      const sha = this.fakeSha('commit');
      repo.commits.set(sha, { sha, message: body.message, tree: treeSha, parents: [] });
      repo.refs.set(body.branch ?? 'main', sha);
      repo.empty = false;
      return json(201, { commit: { sha } });
    }
    return json(404, { message: `Unhandled ${method} ${path}` });
  }) as unknown as typeof fetch;

  /** Simulates somebody pushing a foreign commit to a branch. */
  foreignCommit(repoName: string, branch: string, files: Record<string, string>, message = 'manual edit on github.com') {
    const repo = this.repo(repoName);
    const head = repo.refs.get(branch);
    const baseTree = head ? new Map(repo.trees.get(repo.commits.get(head)?.tree ?? '') ?? []) : new Map<string, string>();
    for (const [p, c] of Object.entries(files)) {
      const bytes = new TextEncoder().encode(c);
      const sha = `foreign${this.counter++}`.padEnd(40, '0');
      repo.blobs.set(sha, bytes);
      baseTree.set(p, sha);
    }
    const tree = this.fakeSha('tree');
    repo.trees.set(tree, baseTree);
    const sha = this.fakeSha('commit');
    repo.commits.set(sha, { sha, message, tree, parents: head ? [head] : [] });
    repo.refs.set(branch, sha);
    repo.empty = false;
    return sha;
  }

  private fakeSha(kind: string) {
    this.counter++;
    return `${kind}${this.counter}`.padEnd(40, 'a').slice(0, 40);
  }
}

export class FakeRepo {
  refs = new Map<string, string>();
  commits = new Map<string, { sha: string; message: string; tree: string; parents: string[] }>();
  trees = new Map<string, Map<string, string>>();
  blobs = new Map<string, Uint8Array>();
  constructor(public empty: boolean) {}

  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const s = stack.pop() as string;
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(this.commits.get(s)?.parents ?? []));
    }
    return false;
  }

  /** Files at the head of a branch, decoded as UTF-8 for easy assertions. */
  files(branch: string): Record<string, string> {
    const head = this.refs.get(branch);
    const tree = head ? this.trees.get(this.commits.get(head)?.tree ?? '') : undefined;
    return Object.fromEntries([...(tree ?? [])].map(([p, sha]) => [p, new TextDecoder().decode(this.blobs.get(sha) ?? new Uint8Array())]));
  }
}
