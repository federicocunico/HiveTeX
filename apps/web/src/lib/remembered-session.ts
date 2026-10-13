export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export type CredentialAction = 'read' | 'save' | 'delete';
export type CredentialResult = { ok: true; token?: string | null; legacy?: boolean } | { ok: false; action: CredentialAction; message: string };
type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const sessionKey = (origin: string) => 'session-token:' + new URL(origin).origin;
export const userCacheKey = (origin: string) => 'hivetex.user:' + new URL(origin).origin;
const blockedKey = (origin: string) => 'hivetex.signedOut:' + new URL(origin).origin;

/** Serializes writes so a delayed sign-in cannot undo sign-out, including deletion failure. */
export class RememberedSession {
  private pending: Promise<unknown> = Promise.resolve();
  private revision = new Map<string, number>();
  constructor(private secure: CredentialStore, private local: LocalStore) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.pending.then(operation, operation);
    this.pending = work.catch(() => {});
    return work;
  }
  private advance(origin: string) {
    const revision = (this.revision.get(origin) ?? 0) + 1;
    this.revision.set(origin, revision);
    return revision;
  }
  private failure(action: CredentialAction): CredentialResult {
    return { ok: false, action, message: action === 'save'
      ? 'You are signed in for this run, but sign-in could not be remembered. Unlock your computer’s credential store and retry.'
      : action === 'read' ? 'Saved sign-in could not be read. Unlock your computer’s credential store and retry, or sign in again.'
      : 'You are signed out, but the saved credential could not be removed. Retry when your computer’s credential store is available.' };
  }
  load(origin: string): Promise<CredentialResult> {
    return this.enqueue(async () => {
      try {
        if (this.local.getItem(blockedKey(origin)) === '1') return { ok: true, token: null };
        const token = await this.secure.get(sessionKey(origin));
        if (token) return { ok: true, token };
        const legacy = await this.secure.get('session-token');
        if (!legacy) return { ok: true, token: null };
        // Only origin metadata written beside the credential is safe attribution; a selected server is not proof.
        if (this.local.getItem('hivetex.session-origin') === new URL(origin).origin) {
          await this.secure.set(sessionKey(origin), legacy);
          const user = this.local.getItem('hivetex.user');
          if (user) this.local.setItem(userCacheKey(origin), user);
          await this.secure.delete('session-token');
          this.local.removeItem('hivetex.user');
          this.local.removeItem('hivetex.session-origin');
          return { ok: true, token: legacy };
        }
        return { ok: true, token: null, legacy: true };
      } catch { return this.failure('read'); }
    });
  }
  save(origin: string, token: string): Promise<CredentialResult> {
    const revision = this.advance(origin);
    try { this.local.setItem(blockedKey(origin), '1'); } catch { /* native save still attempted */ }
    return this.enqueue(async () => {
      try {
        await this.secure.set(sessionKey(origin), token);
        if (this.revision.get(origin) === revision) this.local.removeItem(blockedKey(origin));
        // Retire the old, unattributed format only after an explicit login has a durable replacement.
        await this.secure.delete('session-token').catch(() => {});
        this.local.removeItem('hivetex.session-origin');
        this.local.removeItem('hivetex.user');
        return { ok: true };
      } catch { return this.failure('save'); }
    });
  }
  forget(origin: string): Promise<CredentialResult> {
    this.advance(origin);
    let suppressed = false;
    try { this.local.setItem(blockedKey(origin), '1'); suppressed = true; } catch { /* deletion is still attempted */ }
    return this.enqueue(async () => {
      try {
        await this.secure.delete(sessionKey(origin));
        if (!suppressed) this.local.removeItem(blockedKey(origin));
        return { ok: true };
      } catch { return this.failure('delete'); }
    });
  }
}
