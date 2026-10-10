<script lang="ts">
  import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
  import { defaultKeymap, indentWithTab } from '@codemirror/commands';
  import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
  import { type Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
  import { Compartment, EditorState } from '@codemirror/state';
  import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
  import type { Diagnostic } from '@hivetex/compile';
  import { onDestroy, untrack } from 'svelte';
  import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
  import * as Y from 'yjs';
  import { type ProjectIndex, latexCompletionSource, latexLanguage } from '../lib/latex.js';
  import type { ProjectSession } from '../lib/session.svelte.js';

  let {
    session,
    fileId,
    readOnly,
    diagnostics,
    getIndex,
    jumpLine = null,
    onForwardSearch,
  }: {
    session: ProjectSession;
    fileId: string;
    readOnly: boolean;
    diagnostics: Diagnostic[];
    getIndex: () => ProjectIndex;
    jumpLine?: { line: number; n: number } | null;
    onForwardSearch?: (line: number) => void;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;
  let undo: Y.UndoManager | null = null;
  let loading = $state(true);
  // Role changes (e.g. the owner demotes us to viewer) must flip the editor to read-only without remounting.
  const access = new Compartment();
  const accessExt = (ro: boolean) => [
    EditorState.readOnly.of(ro),
    EditorView.editable.of(!ro),
    EditorView.contentAttributes.of({ 'aria-label': ro ? 'LaTeX source (read-only)' : 'LaTeX source editor' }),
  ];

  async function mount(id: string) {
    loading = true;
    view?.destroy();
    view = null;
    await session.mesh.openDoc(`f:${id}`);
    const ytext = await session.model.openText(id);
    if (!host) return;
    undo = new Y.UndoManager(ytext);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle),
          latexLanguage,
          EditorView.lineWrapping,
          autocompletion({ override: [latexCompletionSource(getIndex)] }),
          lintGutter(),
          keymap.of([
            ...closeBracketsKeymap,
            ...yUndoManagerKeymap,
            ...searchKeymap,
            ...completionKeymap,
            ...defaultKeymap,
            indentWithTab,
            {
              key: 'Mod-Alt-j',
              run: (v) => {
                onForwardSearch?.(v.state.doc.lineAt(v.state.selection.main.head).number);
                return true;
              },
            },
          ]),
          yCollab(ytext, session.mesh.awareness, { undoManager: undo }),
          access.of(accessExt(readOnly)),
        ],
      }),
    });
    loading = false;
    applyDiagnostics();
    applyJump();
  }

  let appliedJump = 0;
  function applyJump() {
    const j = jumpLine;
    if (!j || !view || j.n === appliedJump) return;
    appliedJump = j.n;
    const line = view.state.doc.line(Math.min(Math.max(1, j.line), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    view.focus();
  }

  function applyDiagnostics() {
    if (!view) return;
    const doc = view.state.doc;
    const out: CmDiagnostic[] = [];
    for (const d of diagnostics) {
      if (d.line < 1 || d.line > doc.lines) continue;
      const line = doc.line(d.line);
      out.push({ from: line.from, to: line.to, severity: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info', message: d.message });
    }
    view.dispatch(setDiagnostics(view.state, out));
  }

  $effect(() => {
    const id = fileId;
    untrack(() => void mount(id));
  });

  $effect(() => {
    const ro = readOnly;
    untrack(() => view?.dispatch({ effects: access.reconfigure(accessExt(ro)) }));
  });

  $effect(() => {
    void diagnostics;
    untrack(applyDiagnostics);
  });

  $effect(() => {
    void jumpLine;
    untrack(applyJump);
  });

  onDestroy(() => {
    view?.destroy();
    undo?.destroy();
  });
</script>

<div class="editor-host" bind:this={host} data-testid="editor" data-readonly={readOnly}>
  {#if loading}<p class="muted" style="padding: 12px">Loading…</p>{/if}
</div>
