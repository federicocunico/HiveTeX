<script lang="ts" module>
  import type { SectionLevel } from '../../lib/latex-insert.js';

  export type FormatAction =
    | { kind: 'section'; level: SectionLevel }
    | { kind: 'bold' | 'italic' | 'itemize' | 'enumerate' | 'math' | 'equation' | 'symbol' | 'figure' | 'table' | 'cite' | 'ref' | 'hide' };
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { SECTION_LEVELS } from '../../lib/latex-insert.js';
  import { Bold, ChevronDown, EyeOff, Image, Italic, Link, List, ListOrdered, Omega, Quote, Sigma, SquareSigma, Table } from '../../ui/icons.js';
  import Icon from '../../ui/Icon.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import Menu, { type MenuItem } from '../../ui/Menu.svelte';

  /** Inserts LaTeX for people who do not know it by heart. Each tooltip shows what it writes. */
  let { onAction }: { onAction: (a: FormatAction) => void } = $props();

  const LABEL: Record<SectionLevel, string> = {
    part: 'Part',
    chapter: 'Chapter',
    section: 'Section',
    subsection: 'Subsection',
    subsubsection: 'Subsubsection',
    paragraph: 'Paragraph',
    subparagraph: 'Subparagraph',
  };
  const sectionItems: MenuItem[] = SECTION_LEVELS.map((level) => ({ label: `${LABEL[level]}  \\${level}{…}`, onSelect: () => onAction({ kind: 'section', level }) }));
  const actions = [
    { kind: 'bold', label: 'Bold', icon: Bold, tip: 'Bold: \\textbf{…} (Ctrl+B)' },
    { kind: 'italic', label: 'Italic', icon: Italic, tip: 'Italic: \\textit{…} (Ctrl+I)' },
    { kind: 'itemize', label: 'Bulleted list', icon: List, tip: 'Bulleted list: itemize' },
    { kind: 'enumerate', label: 'Numbered list', icon: ListOrdered, tip: 'Numbered list: enumerate' },
    { kind: 'math', label: 'Inline math', icon: Sigma, tip: 'Inline math: $…$' },
    { kind: 'equation', label: 'Equation', icon: SquareSigma, tip: 'Numbered equation: equation environment' },
    { kind: 'symbol', label: 'Symbol', icon: Omega, tip: 'Insert a symbol: α, ≤, →, ∑ …' },
    { kind: 'figure', label: 'Figure', icon: Image, tip: 'Figure: \\includegraphics with caption and label' },
    { kind: 'table', label: 'Table', icon: Table, tip: 'Table: tabular with caption and label' },
    { kind: 'cite', label: 'Citation', icon: Quote, tip: 'Citation: \\cite{…} from your .bib' },
    { kind: 'ref', label: 'Cross-reference', icon: Link, tip: 'Reference: \\ref{…} to a \\label' },
  ] as const;
  let bar: HTMLDivElement;
  let heading: HTMLSpanElement;
  let moreMeasure: HTMLSpanElement;
  let visible = $state<number>(actions.length);
  const overflow = $derived<MenuItem[]>(actions.slice(visible).map((a) => ({
    label: a.label, icon: a.icon, testid: `fmt-${a.kind}`, onSelect: () => onAction({ kind: a.kind }),
  })));

  onMount(() => {
    function measure() {
      const style = getComputedStyle(bar);
      const gap = Number.parseFloat(style.columnGap);
      const available = bar.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const fixed = heading.getBoundingClientRect().width + 30 + gap;
      const step = 30 + gap;
      const count = available >= fixed + actions.length * step ? actions.length
        : Math.max(0, Math.floor((available - fixed - moreMeasure.getBoundingClientRect().width - gap) / step));
      if (visible !== count) {
        const focused = document.activeElement as HTMLElement | null;
        if (focused && bar.contains(focused) && (actions.slice(count).some((a) => focused.dataset.testid === `fmt-${a.kind}`)
          || (count === actions.length && (focused.dataset.testid === 'fmt-more' || focused.closest('[role="menu"]'))))) {
          heading.querySelector('button')?.focus();
        }
        visible = count;
      }
    }
    const observer = new ResizeObserver(measure);
    observer.observe(bar); observer.observe(heading); observer.observe(moreMeasure);
    measure();
    return () => observer.disconnect();
  });
</script>

<div class="fmt" role="toolbar" aria-label="Formatting" data-testid="format-toolbar" bind:this={bar}>
  <span class="heading" bind:this={heading}>
  <Menu label="Insert a heading" items={sectionItems} triggerClass="fmt-menu" tip={'Headings: \\section{…} and others'} triggerTestid="fmt-section">
    {#snippet trigger()}Heading<Icon icon={ChevronDown} size={14} />{/snippet}
  </Menu>
  </span>
  {#each actions.slice(0, visible) as action (action.kind)}
    <IconButton icon={action.icon} size={30} label={action.label} tip={action.tip} onclick={() => onAction({ kind: action.kind })} data-testid="fmt-{action.kind}" />
  {/each}
  {#if overflow.length}
    <Menu label="More formatting" items={overflow} triggerClass="fmt-menu" triggerTestid="fmt-more">
      {#snippet trigger()}More<Icon icon={ChevronDown} size={14} />{/snippet}
    </Menu>
  {/if}
  <span class="sp"></span>
  <IconButton icon={EyeOff} size={30} label="Hide the formatting toolbar" tip="Hide this toolbar (the actions stay in the command palette)" onclick={() => onAction({ kind: 'hide' })} />
  <span class="measure fmt-menu" aria-hidden="true" bind:this={moreMeasure}>More<Icon icon={ChevronDown} size={14} /></span>
</div>

<style>
  .fmt {
    position: relative;
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: var(--formatbar-h);
    padding: 0 6px;
    border-bottom: 1px solid var(--line);
  }
  .heading { display: inline-flex; flex: none; }
  .fmt :global(button) { flex: none; }
  .measure { position: absolute; visibility: hidden; display: inline-flex; align-items: center; pointer-events: none; }
  .sp {
    flex: 1;
  }
  .fmt :global(.fmt-menu) {
    min-height: 28px;
    gap: 4px;
    padding: 0 8px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
  }
  .fmt :global(.fmt-menu:hover) {
    background: var(--sunken);
    color: var(--ink);
  }
</style>
