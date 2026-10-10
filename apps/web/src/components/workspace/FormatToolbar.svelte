<script lang="ts" module>
  import type { SectionLevel } from '../../lib/latex-insert.js';

  export type FormatAction =
    | { kind: 'section'; level: SectionLevel }
    | { kind: 'bold' | 'italic' | 'itemize' | 'enumerate' | 'math' | 'equation' | 'symbol' | 'figure' | 'table' | 'cite' | 'ref' | 'hide' };
</script>

<script lang="ts">
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
</script>

<div class="fmt" role="toolbar" aria-label="Formatting" data-testid="format-toolbar">
  <Menu label="Insert a heading" items={sectionItems} triggerClass="fmt-menu" tip={'Headings: \\section{…} and others'} triggerTestid="fmt-section">
    {#snippet trigger()}Heading<Icon icon={ChevronDown} size={14} />{/snippet}
  </Menu>
  <span class="sep" aria-hidden="true"></span>
  <IconButton icon={Bold} size={30} label="Bold" tip={'Bold: \\textbf{…} (Ctrl+B)'} onclick={() => onAction({ kind: 'bold' })} />
  <IconButton icon={Italic} size={30} label="Italic" tip={'Italic: \\textit{…} (Ctrl+I)'} onclick={() => onAction({ kind: 'italic' })} />
  <IconButton icon={List} size={30} label="Bulleted list" tip="Bulleted list: itemize" onclick={() => onAction({ kind: 'itemize' })} />
  <IconButton icon={ListOrdered} size={30} label="Numbered list" tip="Numbered list: enumerate" onclick={() => onAction({ kind: 'enumerate' })} />
  <span class="sep" aria-hidden="true"></span>
  <IconButton icon={Sigma} size={30} label="Inline math" tip="Inline math: $…$" onclick={() => onAction({ kind: 'math' })} />
  <IconButton icon={SquareSigma} size={30} label="Equation" tip="Numbered equation: equation environment" onclick={() => onAction({ kind: 'equation' })} />
  <IconButton icon={Omega} size={30} label="Symbol" tip="Insert a symbol: α, ≤, →, ∑ …" onclick={() => onAction({ kind: 'symbol' })} data-testid="fmt-symbol" />
  <span class="sep" aria-hidden="true"></span>
  <IconButton icon={Image} size={30} label="Figure" tip="Figure: \includegraphics with caption and label" onclick={() => onAction({ kind: 'figure' })} data-testid="fmt-figure" />
  <IconButton icon={Table} size={30} label="Table" tip="Table: tabular with caption and label" onclick={() => onAction({ kind: 'table' })} data-testid="fmt-table" />
  <IconButton icon={Quote} size={30} label="Citation" tip={'Citation: \\cite{…} from your .bib'} onclick={() => onAction({ kind: 'cite' })} data-testid="fmt-cite" />
  <IconButton icon={Link} size={30} label="Cross-reference" tip={'Reference: \\ref{…} to a \\label'} onclick={() => onAction({ kind: 'ref' })} data-testid="fmt-ref" />
  <span class="sp"></span>
  <IconButton icon={EyeOff} size={30} label="Hide the formatting toolbar" tip="Hide this toolbar (the actions stay in the command palette)" onclick={() => onAction({ kind: 'hide' })} />
</div>

<style>
  .fmt {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 38px;
    padding: 0 6px;
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .sep {
    flex: none;
    width: 1px;
    height: 18px;
    margin: 0 6px;
    background: var(--line);
  }
  .sp {
    flex: 1;
  }
  .fmt :global(.fmt-menu) {
    min-height: 28px;
    gap: 4px;
    padding: 0 8px;
    border-color: transparent;
    background: transparent;
    color: var(--muted);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .fmt :global(.fmt-menu:hover) {
    background: var(--sunken);
    color: var(--ink);
  }
</style>
