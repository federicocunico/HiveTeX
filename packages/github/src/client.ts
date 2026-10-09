/** Minimal GitHub REST client (Git Data API) used from the user's own device. The token never leaves it. */

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface TreeEntry {
  path: string;
  mode: '100644' | '100755' | '040000';
  type: 'blob' | 'tree';
  sha: string | null;
}

export class GitHubClient {
  constructor(
    private token: string,
    private f: typeof fetch = fetch.bind(globalThis),
    private base = 'https://api.github.com',
  ) {}

  setToken(t: string) {
    this.token = t;
  }

  async req<T>(method: string, path: string, body?: unknown, ok: number[] = []): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok && !ok.includes(res.status)) throw new GitHubError(res.status, (json as { message?: string }).message ?? res.statusText);
    return Object.assign(json as object, { _status: res.status }) as T;
  }

  user() {
    return this.req<{ login: string; id: number }>('GET', '/user');
  }
  repo({ owner, repo }: RepoRef) {
    return this.req<{ default_branch: string; private: boolean; permissions?: { push?: boolean } }>('GET', `/repos/${owner}/${repo}`);
  }
  createRepo(name: string, isPrivate = true) {
    return this.req<{ full_name: string; default_branch: string; owner: { login: string } }>('POST', '/user/repos', {
      name,
      private: isPrivate,
      description: 'LaTeX project backup from p2platex',
      auto_init: false,
    });
  }
  async getRef({ owner, repo }: RepoRef, branch: string): Promise<string | null> {
    const r = await this.req<{ object?: { sha: string }; _status: number }>('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, '/')}`, undefined, [404, 409]);
    return r._status === 200 ? (r.object?.sha ?? null) : null;
  }
  getCommit({ owner, repo }: RepoRef, sha: string) {
    return this.req<{ sha: string; message: string; tree: { sha: string }; parents: Array<{ sha: string }> }>('GET', `/repos/${owner}/${repo}/git/commits/${sha}`);
  }
  getTree({ owner, repo }: RepoRef, sha: string) {
    return this.req<{ tree: Array<{ path: string; type: string; sha: string; mode: string }>; truncated: boolean }>('GET', `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  }
  async getBlob({ owner, repo }: RepoRef, sha: string): Promise<Uint8Array> {
    const r = await this.req<{ content: string; encoding: string }>('GET', `/repos/${owner}/${repo}/git/blobs/${sha}`);
    return Uint8Array.from(atob(r.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  }
  async createBlob({ owner, repo }: RepoRef, bytes: Uint8Array): Promise<string> {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await this.req<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, { content: btoa(s), encoding: 'base64' });
    return r.sha;
  }
  async createTree({ owner, repo }: RepoRef, baseTree: string | null, tree: TreeEntry[]): Promise<string> {
    const r = await this.req<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, { ...(baseTree ? { base_tree: baseTree } : {}), tree });
    return r.sha;
  }
  async createCommit({ owner, repo }: RepoRef, message: string, tree: string, parents: string[]): Promise<string> {
    const r = await this.req<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/commits`, { message, tree, parents });
    return r.sha;
  }
  createRef({ owner, repo }: RepoRef, branch: string, sha: string) {
    return this.req<{ ref: string }>('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }
  /** Fast-forward only: GitHub rejects a non-fast-forward update when force is false. */
  updateRef({ owner, repo }: RepoRef, branch: string, sha: string) {
    return this.req<{ ref: string }>('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha, force: false });
  }
  /** Seeds an empty repository (the Git Data API cannot write to a repo without commits). */
  async seedEmptyRepo({ owner, repo }: RepoRef, branch: string): Promise<void> {
    await this.req('PUT', `/repos/${owner}/${repo}/contents/.p2platex`, {
      message: 'Initialize p2platex backup',
      content: btoa('managed by p2platex\n'),
      branch,
    });
  }
}

/** Git blob object id: sha1("blob <len>\0" + content), computed locally so unchanged files are never uploaded. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  const d = await globalThis.crypto.subtle.digest('SHA-1', all);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
