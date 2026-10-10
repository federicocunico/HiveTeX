<script lang="ts">
  import { copyText } from '../lib/clipboard.js';
  import { onMount } from 'svelte';
  import { apiBase, isDesktop } from '../lib/api.js';
  import { ProjectAdmin, invitationText } from '../lib/project-admin.svelte.js';
  import type { ProjectSession } from '../lib/session.svelte.js';
  import Dialog from '../ui/Dialog.svelte';
  import { Copy, Lock, LockOpen } from '../ui/icons.js';
  import Icon from '../ui/Icon.svelte';
  import { toast } from '../ui/toast.svelte.js';
  import JoiningSection from './JoiningSection.svelte';
  import MembersSection from './MembersSection.svelte';

  /**
   * Inviting co-authors. Everyone can copy the invitation (ID and how to join, never the password); owners also
   * manage the password, the default role and members here, with the same rules as Project settings.
   */
  let { session, onClose }: { session: ProjectSession; onClose: () => void } = $props();

  const admin = new ProjectAdmin(session);
  onMount(() => void admin.load());

  const appUrl = isDesktop ? apiBase() || location.origin : location.origin;

  async function copy() {
    const text = invitationText(session.project.slug, appUrl, session.project.passwordProtected);
    try {
      await copyText(text);
      toast('Invitation copied. Send the password separately.');
    } catch {
      toast(`Project ID: ${session.project.slug}`, 'info');
    }
  }
</script>

<Dialog title={`Share “${session.project.slug}”`} size="lg" {onClose} testid="share-dialog">
  {#if admin.error}<div class="error msg" role="alert">{admin.error}</div>{/if}
  {#if admin.info}<div class="notice msg" role="status">{admin.info}</div>{/if}

  <section class="invite">
    <label for="share-id">Co-authors join with this project ID</label>
    <div class="idrow">
      <input id="share-id" class="mono" type="text" value={session.project.slug} readonly data-testid="share-id" />
      <button type="button" class="primary" onclick={copy} data-testid="copy-invitation" data-autofocus><Icon icon={Copy} />Copy invitation</button>
    </div>
    <p class="hint">
      {#if session.project.passwordProtected}
        <Icon icon={Lock} size={14} />The invitation says how to join. It does not contain the password; send that separately.
      {:else}
        <Icon icon={LockOpen} size={14} />No password: anyone with the ID can join.
      {/if}
    </p>
  </section>

  {#if admin.isOwner}
    <JoiningSection {admin} showId={false} />
    <MembersSection {admin} />
  {:else}
    <p class="muted note">Only the owner can change the password and who has access.</p>
  {/if}
</Dialog>

<style>
  section {
    display: grid;
    gap: 8px;
  }
  label {
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .idrow {
    display: flex;
    gap: 8px;
  }
  .idrow input {
    flex: 1;
    min-width: 0;
  }
  .hint {
    margin: 0;
    display: flex;
    gap: 6px;
    align-items: center;
    color: var(--muted);
    font-size: 12.5px;
  }
  .msg {
    padding: 8px 10px;
    margin: 0;
  }
  .note {
    margin: 0;
  }
</style>
