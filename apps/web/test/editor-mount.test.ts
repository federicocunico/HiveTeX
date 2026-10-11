// @vitest-environment jsdom
import { render } from '@testing-library/svelte';
import { EditorView } from '@codemirror/view';
import { tick } from 'svelte';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import Editor from '../src/components/Editor.svelte';

/**
 * The editor follows the selected file (F16): loads that finish out of order, after a replacement, or after the
 * editor was closed never leave a stale, extra or leaked editor behind.
 */

const flush = async () => {
  await tick();
  await new Promise((r) => setTimeout(r, 0));
  await tick();
};

function fake() {
  const docs = new Map<string, Y.Doc>();
  const gates = new Map<string, Array<() => void>>();
  const replaced = new Set<(docId: string) => void>();
  const awareness = new Awareness(new Y.Doc());
  const doc = (id: string, text?: string) => {
    let d = docs.get(id);
    if (!d) {
      d = new Y.Doc();
      d.getText('t').insert(0, text ?? `text of ${id}`);
      docs.set(id, d);
    }
    return d;
  };
  const session = {
    mesh: { awareness, openDoc: async () => {} },
    model: {
      openText: (id: string) =>
        new Promise<Y.Text>((resolve) => {
          const list = gates.get(id) ?? [];
          list.push(() => resolve(doc(id).getText('t')));
          gates.set(id, list);
        }),
      onDocReplaced: (l: (docId: string) => void) => {
        replaced.add(l);
        return () => replaced.delete(l);
      },
      getLoadedDoc: (docId: string) => docs.get(docId.slice(2)),
    },
  };
  return {
    session: session as never,
    doc,
    /** Completes the oldest pending load of `id`. */
    release: (id: string) => gates.get(id)?.shift()?.(),
    pending: (id: string) => gates.get(id)?.length ?? 0,
    replace: (id: string) => {
      docs.delete(id);
      doc(id, `replaced ${id}`);
      for (const l of [...replaced]) l(`f:${id}`);
    },
  };
}

const props = (session: never, fileId: string) => ({ session, fileId, readOnly: false, diagnostics: [], getIndex: () => ({}) as never });
const views = (c: HTMLElement) => c.querySelectorAll('.cm-editor').length;
const viewOf = (c: HTMLElement) => EditorView.findFromDOM(c.querySelector('.cm-editor') as HTMLElement)!;
/** UndoManagers register one `afterTransaction` observer on their document until destroyed. */
const undoManagers = (d: Y.Doc) => (d as unknown as { _observers: Map<string, Set<unknown>> })._observers.get('afterTransaction')?.size ?? 0;

describe('Editor mounting', () => {
  it('keeps the selected file when loads finish in reverse order', async () => {
    const w = fake();
    const { container, rerender } = render(Editor, { props: props(w.session, 'a') });
    await flush();
    await rerender(props(w.session, 'b'));
    await flush();
    w.release('b');
    await flush();
    w.release('a');
    await flush();
    expect(views(container)).toBe(1);
    expect(viewOf(container).state.doc.toString()).toBe('text of b');
    viewOf(container).dispatch({ changes: { from: 0, insert: '!' } });
    expect(w.doc('b').getText('t').toString()).toBe('!text of b');
    expect(w.doc('a').getText('t').toString()).toBe('text of a');
    expect(undoManagers(w.doc('a'))).toBe(0);
    expect(undoManagers(w.doc('b'))).toBe(1);
  });

  it('leaves exactly one correctly bound editor after repeated switches', async () => {
    const w = fake();
    const { container, rerender } = render(Editor, { props: props(w.session, 'a') });
    for (const id of ['b', 'a', 'c', 'b', 'a']) {
      w.release(id === 'a' ? 'b' : 'a');
      await flush();
      await rerender(props(w.session, id));
      await flush();
    }
    for (const id of ['a', 'b', 'c']) while (w.pending(id)) w.release(id);
    await flush();
    expect(views(container)).toBe(1);
    expect(viewOf(container).state.doc.toString()).toBe('text of a');
    expect(undoManagers(w.doc('a'))).toBe(1);
    expect(undoManagers(w.doc('b'))).toBe(0);
    expect(undoManagers(w.doc('c'))).toBe(0);
  });

  it('does not duplicate when the document is replaced during a load', async () => {
    const w = fake();
    const { container } = render(Editor, { props: props(w.session, 'a') });
    await flush();
    w.replace('a');
    await flush();
    expect(w.pending('a')).toBe(2);
    w.release('a'); // the load that started first resolves last in the worst case
    w.release('a');
    await flush();
    expect(views(container)).toBe(1);
    expect(viewOf(container).state.doc.toString()).toBe('replaced a');
    expect(undoManagers(w.doc('a'))).toBe(1);
  });

  it('does not recreate the editor when the project closes while loading', async () => {
    const w = fake();
    const { container, unmount } = render(Editor, { props: props(w.session, 'a') });
    await flush();
    const d = w.doc('a');
    unmount();
    w.release('a');
    await flush();
    expect(container.querySelectorAll('.cm-editor').length).toBe(0);
    expect(document.querySelectorAll('.cm-editor').length).toBe(0);
    expect(undoManagers(d)).toBe(0);
  });
});
