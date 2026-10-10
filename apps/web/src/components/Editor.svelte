<script lang="ts">
  import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
  import { defaultKeymap, indentWithTab } from '@codemirror/commands';
  import { bracketMatching, indentOnInput } from '@codemirror/language';
  import { type Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
  import { Compartment, EditorState, Prec } from '@codemirror/state';
  import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
  import { activeLineWhenNoSelection } from '../lib/active-line.js';
  import type { Diagnostic } from '@hivetex/compile';
  import { onDestroy, untrack } from 'svelte';
  import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
  import * as Y from 'yjs';
  import { type ProjectIndex, latexCompletionSource, latexLanguage } from '../lib/latex.js';
  import { editorCommandForKey } from '../lib/commands.svelte.js';
  import { type Insertion, inMathAt } from '../lib/latex-insert.js';
  import { prefs } from '../lib/preferences.svelte.js';
  import type { ProjectSession } from '../lib/session.svelte.js';
  import { editorFontSize, hivetexEditorTheme } from '../styles/editor-theme.js';

  let {
    session,
    fileId,
    readOnly,
    diagnostics,
    getIndex,
    jumpLine = null,
    onForwardSearch,
    onCursor,
    onKeymapMode,
    onUserActivity,
  }: {
    session: ProjectSession;
    fileId: string;
    readOnly: boolean;
    diagnostics: Diagnostic[];
    getIndex: () => ProjectIndex;
    jumpLine?: { line: number; n: number } | null;
    onForwardSearch?: (line: number) => void;
    /** Cursor position (1-based line and column) for the status bar. */
    onCursor?: (pos: { line: number; col: number }) => void;
    /** Vim mode ("-- NORMAL --") or "Emacs" for the status bar; '' with the default keys. */
    onKeymapMode?: (mode: string) => void;
    /** The user typed, scrolled or clicked in the editor (ends "follow"). */
    onUserActivity?: () => void;
  } = $props();

  /**
   * Replaces the selection with what `build` returns (toolbar, pickers, fixes), as one ordinary edit by this user:
   * it syncs, appears in Changes and undoes like typing. Returns false when the editor is read-only or not ready.
   */
  export function insertWith(build: (selected: string, ctx: { inMath: boolean }) => Insertion): boolean {
    if (!view || readOnly) return false;
    const { from, to } = view.state.selection.main;
    const ins = build(view.state.sliceDoc(from, to), { inMath: inMathAt(view.state.doc.toString(), from) });
    view.dispatch({
      changes: { from, to, insert: ins.text },
      selection: { anchor: from + ins.anchor, head: from + (ins.head ?? ins.anchor) },
      scrollIntoView: true,
      userEvent: 'input.format',
    });
    view.focus();
    return true;
  }

  /** Inserts `text` at the start of line `line` (1-based), e.g. a missing \usepackage in the preamble. */
  export function insertLineBefore(line: number, text: string): boolean {
    if (!view || readOnly) return false;
    const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    view.dispatch({ changes: { from: l.from, insert: `${text}\n` }, userEvent: 'input.fix' });
    return true;
  }

  /** Scrolls a co-author's cursor (by awareness client id) into view, if they are in this file. */
  export function revealClient(clientId: number): boolean {
    const st = session.mesh.awareness.getStates().get(clientId) as { cursor?: { head?: unknown } } | undefined;
    if (!view || !ytext?.doc || !st?.cursor?.head) return false;
    const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(st.cursor.head), ytext.doc);
    if (!pos || pos.type !== ytext) return false;
    view.dispatch({ effects: EditorView.scrollIntoView(Math.min(pos.index, view.state.doc.length), { y: 'center' }) });
    return true;
  }

  /** Current text of the open file. */
  export function text(): string {
    return view?.state.doc.toString() ?? '';
  }

  // Optional Vim or Emacs keys, downloaded only when chosen.
  const keymapMode = new Compartment();
  let loadedKeymap = 'default';
  async function applyKeymap(k: string) {
    if (!view || k === loadedKeymap) return;
    loadedKeymap = k;
    if (k === 'vim') {
      const { vim, getCM } = await import('@replit/codemirror-vim');
      if (!view || loadedKeymap !== 'vim') return;
      view.dispatch({ effects: keymapMode.reconfigure(vim({ status: false })) });
      onKeymapMode?.('-- NORMAL --');
      getCM(view)?.on('vim-mode-change', (e: { mode: string; subMode?: string }) =>
        onKeymapMode?.(`-- ${(e.subMode ? `${e.mode} ${e.subMode}` : e.mode).toUpperCase()} --`),
      );
    } else if (k === 'emacs') {
      const { emacs } = await import('@replit/codemirror-emacs');
      if (!view || loadedKeymap !== 'emacs') return;
      view.dispatch({ effects: keymapMode.reconfigure(emacs()) });
      onKeymapMode?.('Emacs');
    } else {
      view.dispatch({ effects: keymapMode.reconfigure([]) });
      onKeymapMode?.('');
    }
  }

  // App shortcuts typed in the editor (Ctrl+Enter compiles, Ctrl+K opens the palette, …) come from the command
  // registry, checked before CodeMirror's own keymap.
  const appKeys = Prec.highest(
    EditorView.domEventHandlers({
      keydown(e) {
        if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) onUserActivity?.();
        const c = editorCommandForKey(e);
        if (!c) return false;
        e.preventDefault();
        c.run();
        return true;
      },
      wheel() {
        onUserActivity?.();
        return false;
      },
      mousedown() {
        onUserActivity?.();
        return false;
      },
    }),
  );

  const reportCursor = EditorView.updateListener.of((u) => {
    if (!onCursor || !(u.selectionSet || u.docChanged || u.focusChanged)) return;
    const head = u.state.selection.main.head;
    const line = u.state.doc.lineAt(head);
    onCursor({ line: line.number, col: head - line.from + 1 });
  });

  let host: HTMLDivElement;
  let view: EditorView | null = null;
  let undo: Y.UndoManager | null = null;
  let ytext: Y.Text | null = null;
  let loading = $state(true);
  // Role changes (e.g. the owner demotes us to viewer) must flip the editor to read-only without remounting.
  const access = new Compartment();
  const fontSize = new Compartment();
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
    ytext = await session.model.openText(id);
    if (!host) return;
    undo = new Y.UndoManager(ytext);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          // first, so Vim/Emacs bindings take precedence over the default keymap
          keymapMode.of([]),
          lineNumbers(),
          drawSelection(),
          activeLineWhenNoSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          hivetexEditorTheme,
          fontSize.of(editorFontSize(prefs.editorFontSize)),
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
          reportCursor,
          appKeys,
        ],
      }),
    });
    loading = false;
    loadedKeymap = 'default';
    void applyKeymap(prefs.keymap);
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
    const k = prefs.keymap;
    untrack(() => void applyKeymap(k));
  });

  $effect(() => {
    const px = prefs.editorFontSize;
    untrack(() => view?.dispatch({ effects: fontSize.reconfigure(editorFontSize(px)) }));
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
