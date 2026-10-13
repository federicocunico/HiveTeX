import { api } from './api.js';
import type { ProjectSession } from './session.svelte.js';

export interface Member {
  userId: string;
  username: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: string;
}

/**
 * Owner-side project access: members and roles, default role, project ID and password. Shared by Project settings
 * and the Share dialog, so both apply exactly the same rules and messages.
 */
export class ProjectAdmin {
  members = $state<Member[]>([]);
  bans = $state<string[]>([]);
  defaultRole = $state('viewer');
  slug = $state('');
  newPassword = $state('');
  error = $state('');
  info = $state('');
  private roleTouched = false;

  constructor(readonly session: ProjectSession) {
    this.defaultRole = session.project.defaultRole;
    this.slug = session.project.slug;
  }

  get isOwner() {
    return this.session.role === 'owner';
  }

  private get pid() {
    return this.session.project.id;
  }

  async load() {
    if (!this.isOwner) return;
    try {
      const r = await api<{ members: Member[]; bans: string[]; project: { defaultRole: string } }>('GET', `/projects/${this.pid}`);
      this.members = r.members;
      this.bans = r.bans;
      if (!this.roleTouched) this.defaultRole = r.project.defaultRole;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to load members';
    }
  }

  private async act(fn: () => Promise<unknown>, ok = 'Saved') {
    this.error = '';
    this.info = '';
    try {
      await fn();
      this.info = ok;
      await this.session.refreshTicketNow(); // announce the new membership epoch to peers right away
      await this.load();
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed';
      return false;
    }
  }

  touchDefaultRole() {
    this.roleTouched = true;
  }

  setRole(m: Member, role: string) {
    return this.act(() => api('PATCH', `/projects/${this.pid}/members/${m.userId}`, { role }), `${m.username} is now ${role}`);
  }

  remove(m: Member, ban: boolean) {
    return this.act(() => api('DELETE', `/projects/${this.pid}/members/${m.userId}`, { ban }), ban ? `${m.username} removed and banned` : `${m.username} removed`);
  }

  saveDefault() {
    return this.act(async () => {
      await api('PATCH', `/projects/${this.pid}`, { defaultRole: this.defaultRole });
      this.roleTouched = false;
    });
  }

  saveSlug() {
    return this.act(async () => {
      const r = await api<{ project: { slug: string } }>('PATCH', `/projects/${this.pid}`, { slug: this.slug });
      this.slug = r.project.slug;
      await this.session.updateShareId(r.project.slug);
    }, 'Project ID changed. Copy the full new ID from Share.');
  }

  savePassword() {
    return this.act(async () => {
      await api('PATCH', `/projects/${this.pid}`, { password: this.newPassword });
      this.newPassword = '';
    }, 'Password changed (existing members keep access)');
  }

  disablePassword() {
    return this.act(() => api('PATCH', `/projects/${this.pid}`, { password: null }), 'Password protection disabled');
  }

  deleteProject() {
    return this.act(() => api('DELETE', `/projects/${this.pid}`), 'Deleted');
  }
}

/**
 * The text "Copy invitation" puts on the clipboard: where to go and the ID. Never the password, which the owner
 * sends separately.
 */
export function invitationText(slug: string, appUrl: string, passwordProtected: boolean): string {
  return [
    `Join my HiveTeX project "${slug}".`,
    '',
    `1. Open ${appUrl} (or the HiveTeX desktop app) and sign in or create an account.`,
    `2. Choose "Join with ID" and enter the project ID: ${slug}`,
    passwordProtected ? '3. Enter the project password. I will send it to you separately.' : '3. No password is needed.',
  ].join('\n');
}
