import type { Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

const lineDeco = Decoration.line({ class: 'cm-activeLine' });

function decorations(view: EditorView): DecorationSet {
  const ranges = view.state.selection.ranges;
  // While text is selected, no line is tinted: the tint is painted over the selection layer and would hide the
  // selection on the cursor's line (the last line of a mouse or Shift selection).
  if (ranges.some((r) => !r.empty)) return Decoration.none;
  const lines = new Set<number>();
  for (const r of ranges) lines.add(view.state.doc.lineAt(r.head).from);
  return Decoration.set([...lines].sort((a, b) => a - b).map((from) => lineDeco.range(from)));
}

/** The current line's highlight, shown only when nothing is selected (replaces `highlightActiveLine()`). */
export function activeLineWhenNoSelection(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorations(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = decorations(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
