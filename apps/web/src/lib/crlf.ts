import { EditorSelection, EditorState, type Extension } from '@codemirror/state';

/**
 * Files with Windows line endings (CRLF). The editor splits lines on `\n` only, so its text is exactly the shared text
 * (same length, same offsets). That leaves each line's `\r` as its last character: this keeps an empty cursor in front
 * of it, so End and typing at the end of a line work as in any editor and the line ending stays intact.
 */
export function crlfAware(): Extension {
  return [
    EditorState.lineSeparator.of('\n'),
    EditorState.transactionFilter.of((tr) => {
      if (!tr.selection) return tr;
      const doc = tr.newDoc;
      let moved = false;
      const ranges = tr.selection.ranges.map((r) => {
        if (!r.empty || r.head === 0) return r;
        const before = doc.sliceString(r.head - 1, r.head);
        const after = r.head < doc.length ? doc.sliceString(r.head, r.head + 1) : '';
        if (before === '\r' && (after === '\n' || after === '')) {
          moved = true;
          return EditorSelection.cursor(r.head - 1);
        }
        return r;
      });
      return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }] : tr;
    }),
  ];
}
