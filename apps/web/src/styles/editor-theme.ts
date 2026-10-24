import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Editor look built from the design tokens (CSS variables), so switching theme needs no editor reconfiguration.
 * The stex mode reports commands as `tag`, math delimiters as `keyword`, environment names and math identifiers as
 * `variableName.special`.
 */
export const hivetexHighlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--syn-cmd)' },
  { tag: t.keyword, color: 'var(--syn-math)' },
  { tag: [t.number, t.atom], color: 'var(--syn-math)' },
  { tag: t.special(t.variableName), color: 'var(--syn-env)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.bracket, t.brace, t.squareBracket, t.paren], color: 'var(--syn-brace)' },
  { tag: t.string, color: 'var(--syn-string)' },
  // stex marks a few harmless characters as errors; keep them readable instead of alarming.
  { tag: t.invalid, color: 'inherit' },
]);

const LINE_HEIGHT = 1.65;
const base = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--ink)',
    backgroundColor: 'var(--surface)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: String(LINE_HEIGHT),
  },
  // CRLF is preserved in the shared document. A CR-only line is not empty to CodeMirror,
  // but collapses as whitespace in the browser; it must still occupy one visual text row.
  '.cm-line': { minHeight: `${LINE_HEIGHT}em` },
  '.cm-content': { caretColor: 'var(--ink)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--faint)',
    border: 'none',
    userSelect: 'none',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--ink)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 6px', minWidth: '32px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--honey-soft)',
    outline: '1px solid var(--honey)',
    color: 'inherit',
  },
  '.cm-nonmatchingBracket': { backgroundColor: 'var(--bad-soft)', color: 'var(--bad)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--honey-soft)' },
  '.cm-searchMatch': { backgroundColor: 'var(--honey-soft)', outline: '1px solid var(--honey)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--selection)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--raised)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--r-m)',
    boxShadow: 'var(--shadow-2)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-code)', fontSize: '0.92em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--honey-soft)', color: 'var(--ink)' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700', color: 'var(--honey-ink)' },
  '.cm-diagnostic': { padding: '6px 10px', fontFamily: 'var(--font-ui)' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--bad)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn)' },
  '.cm-diagnostic-info': { borderLeft: '3px solid var(--muted)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--bad)', textUnderlineOffset: '4px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn)', textUnderlineOffset: '4px' },
  '.cm-panels': { backgroundColor: 'var(--sunken)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--font-ui)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { fontSize: '13px' },
  '.cm-textfield': {
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-s)',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-s)',
  },
  // Remote cursors and selections (y-codemirror.next)
  '.cm-ySelectionInfo': {
    fontFamily: 'var(--font-ui)',
    fontWeight: '600',
    fontSize: '10.5px',
    padding: '2px 5px',
    borderRadius: '3px 3px 3px 0',
    opacity: '1',
    color: 'var(--on-presence)',
  },
});

/** The theme plus syntax colors. */
export const hivetexEditorTheme: Extension = [base, syntaxHighlighting(hivetexHighlight)];

/** Editor text size; reconfigure through a Compartment when the preference changes. */
export function editorFontSize(px: number): Extension {
  return EditorView.theme({ '.cm-scroller': { fontSize: `${px}px` } });
}
