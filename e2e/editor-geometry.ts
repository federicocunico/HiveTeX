import { expect, type Page } from '@playwright/test';
import type { EditorView } from '../apps/web/node_modules/@codemirror/view';

export type EditorHost = HTMLElement & { __hivetexEditor: EditorView };

/** Match gutter labels to logical lines, including wrapped/virtualized text. Executed inside the real browser. */
export function geometry() {
  const view = (document.querySelector('[data-testid=editor]') as EditorHost)?.__hivetexEditor;
  if (!view) throw new Error('No active development editor');
  const viewport = view.scrollDOM.getBoundingClientRect();
  const rows: Array<{ line: number; delta: number; top: number; gutter: number; height: number }> = [];
  for (const el of view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')) {
    if (getComputedStyle(el).visibility === 'hidden' || !/^\d+$/.test(el.textContent?.trim() ?? '')) continue;
    const line = Number(el.textContent?.trim());
    if (line > view.state.doc.lines) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= viewport.top || r.top >= viewport.bottom) continue;
    const at = view.state.doc.line(line).from;
    const dom = view.domAtPos(at);
    const element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node as Element;
    const row = element?.closest('.cm-line');
    if (!row || view.posAtDOM(row, 0) !== at) continue;
    const top = row.getBoundingClientRect().top;
    rows.push({ line, top, gutter: r.top, delta: Math.abs(r.top - top), height: row.getBoundingClientRect().height });
  }
  return {
    maxDelta: Math.max(0, ...rows.map((r) => r.delta)), rows,
    collapsed: rows.filter((r) => r.height < view.defaultLineHeight - 1.5).map((r) => r.line),
    font: getComputedStyle(view.contentDOM).fontSize,
    lineHeight: getComputedStyle(view.contentDOM).lineHeight,
    documentOverflow: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    selection: view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
  };
}

export async function aligned(page: Page) {
  await expect.poll(async () => {
    const g = await page.evaluate(geometry);
    return g.rows.length >= 3 && !g.collapsed.length && g.maxDelta <= 1.5 && g.documentOverflow <= 1;
  }, { message: 'visible logical line numbers align with source; no blank viewport or outer scroll', timeout: 5000 }).toBe(true);
  return page.evaluate(geometry);
}

export async function scrollToLine(page: Page, n: number) {
  await page.evaluate((line) => {
    const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
    const block = view.lineBlockAt(view.state.doc.line(line).from);
    view.scrollDOM.scrollTop = block.top;
    view.requestMeasure();
  }, n);
}
