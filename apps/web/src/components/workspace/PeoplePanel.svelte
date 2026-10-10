<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ProjectSession } from '../../lib/session.svelte.js';
  import { Share } from '../../ui/icons.js';
  import Avatar from '../../ui/Avatar.svelte';
  import Icon from '../../ui/Icon.svelte';
  import PanelHead from './PanelHead.svelte';

  /** Who is in the project right now, where they are, and a way to invite more people. */
  let {
    session,
    onShare,
    fileOf = () => null,
    actions,
  }: {
    session: ProjectSession;
    onShare: () => void;
    /** The file a co-author (by username) has open, if known. */
    fileOf?: (name: string) => string | null;
    /** Per-person actions (e.g. Follow). */
    actions?: Snippet<[{ dev: string; name: string }]>;
  } = $props();

  const ROLE: Record<string, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
</script>

<section class="panel" aria-labelledby="people-title" data-testid="people-panel">
  <PanelHead title="People" id="people-title" />
  <ul class="people">
    <li>
      <Avatar name={session.user.username} size={28} />
      <span class="who"><strong>{session.user.username} (you)</strong><span class="meta">{ROLE[session.role] ?? session.role} · this device</span></span>
    </li>
    {#each session.peers as p (p.dev)}
      {@const file = fileOf(p.uname)}
      <li>
        <Avatar name={p.uname} size={28} />
        <span class="who"><strong>{p.uname}</strong><span class="meta">{ROLE[p.role] ?? p.role} · online{file ? ` · ${file}` : ''}</span></span>
        {@render actions?.({ dev: p.dev, name: p.uname })}
      </li>
    {/each}
  </ul>
  {#if session.peers.length === 0}
    <p class="intro">No co-author is online right now. Their edits arrive when they connect.</p>
  {/if}
  <div class="invite">
    <button type="button" onclick={onShare}><Icon icon={Share} />Invite co-authors</button>
  </div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }
  .people {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px;
  }
  .who {
    display: grid;
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
  }
  .who strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .meta {
    color: var(--muted);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .intro {
    margin: 4px 14px 10px;
    color: var(--muted);
    font-size: 12.5px;
  }
  .invite {
    padding: 8px 14px 14px;
  }
</style>
