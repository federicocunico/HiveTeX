/**
 * SyncTeX navigation between source lines and PDF positions, computed from the .synctex.gz that the
 * compile leader publishes alongside the PDF. Coordinates are PDF points (bp), origin top-left.
 *
 * A SyncTeX file lists, per page, nested boxes and the glyph-run / glue / kern / math nodes inside them,
 * each tagged with its input file and source line. Text lives in horizontal boxes `( ... )`; the box carries
 * the line of the paragraph end while the nodes inside carry the line of the actual source tokens, so
 * lookups consider the enclosing hbox and its children.
 */

export interface SyncNode {
  kind: string;
  tag: number;
  line: number;
  x: number;
  y: number;
  w: number;
  h: number;
  d: number;
  /** Nearest enclosing horizontal box (for leaf nodes). */
  box?: SyncNode;
  /** Leaf nodes inside this box (for horizontal boxes). */
  children?: SyncNode[];
}

export interface SyncIndex {
  inputs: Map<number, string>;
  pages: Map<number, SyncNode[]>;
}

const SP_PER_BP = 65781.76;

export async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function parseSyncTeXGz(bytes: Uint8Array): Promise<SyncIndex> {
  return parseSyncTeX(await gunzip(bytes));
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

export function parseSyncTeX(text: string): SyncIndex {
  const inputs = new Map<number, string>();
  const pages = new Map<number, SyncNode[]>();
  let unit = 1;
  let mag = 1000;
  let xOff = 0;
  let yOff = 0;
  let page = 0;
  let inContent = false;
  const boxes: SyncNode[] = []; // stack of open '(' and '[' boxes
  const scale = () => (unit * mag) / 1000 / SP_PER_BP;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!inContent) {
      if (line.startsWith('Input:')) {
        const m = /^Input:(\d+):(.*)$/.exec(line);
        if (m) inputs.set(Number(m[1]), norm(m[2] as string));
      } else if (line.startsWith('Magnification:')) mag = Number(line.slice(14)) || 1000;
      else if (line.startsWith('Unit:')) unit = Number(line.slice(5)) || 1;
      else if (line.startsWith('X Offset:')) xOff = Number(line.slice(9)) || 0;
      else if (line.startsWith('Y Offset:')) yOff = Number(line.slice(9)) || 0;
      else if (line === 'Content:') inContent = true;
      continue;
    }
    const c = line[0];
    if (!c) continue;
    if (c === '{') {
      page = Number(line.slice(1));
      pages.set(page, pages.get(page) ?? []);
      boxes.length = 0;
      continue;
    }
    if (c === '}' || c === '!') continue;
    if (c === ')' || c === ']') {
      boxes.pop();
      continue;
    }
    if (line.startsWith('Postamble')) break;
    if (!'[(hvxkg$'.includes(c)) continue;
    const m = /^.(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/.exec(line);
    if (!m) continue;
    const k = scale();
    const node: SyncNode = {
      kind: c,
      tag: Number(m[1]),
      line: Number(m[2]),
      x: (Number(m[3]) + xOff) * k,
      y: (Number(m[4]) + yOff) * k,
      w: m[5] ? Number(m[5]) * k : 0,
      h: m[6] ? Number(m[6]) * k : 0,
      d: m[7] ? Number(m[7]) * k : 0,
    };
    const hbox = [...boxes].reverse().find((b) => b.kind === '(');
    if (hbox) {
      node.box = hbox;
      if (c !== '(' && c !== '[') {
        hbox.children = hbox.children ?? [];
        hbox.children.push(node);
      }
    }
    pages.get(page)?.push(node);
    if (c === '(') node.children = [];
    if (c === '(' || c === '[') boxes.push(node);
  }
  return { inputs, pages };
}

function tagsFor(index: SyncIndex, file: string): Set<number> {
  const f = norm(file);
  const out = new Set<number>();
  for (const [tag, p] of index.inputs) if (p === f || p.endsWith(`/${f}`) || f.endsWith(`/${p}`)) out.add(tag);
  return out;
}

export interface PdfPosition {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const isText = (n: SyncNode) => n.kind === 'x' || n.kind === 'g' || n.kind === 'k' || n.kind === '$' || n.kind === 'h';

/** Source -> PDF: where is `file:line` on the page? Falls back to the nearest following line that produced output. */
export function forwardSearch(index: SyncIndex, file: string, line: number): PdfPosition | null {
  const tags = tagsFor(index, file);
  if (tags.size === 0) return null;
  let best: { page: number; node: SyncNode; dist: number } | null = null;
  for (const [page, nodes] of [...index.pages].sort((a, b) => a[0] - b[0])) {
    for (const n of nodes) {
      if (!tags.has(n.tag) || !isText(n) || !n.box) continue;
      const dist = n.line >= line ? n.line - line : (line - n.line) * 1000;
      if (!best || dist < best.dist) best = { page, node: n, dist };
    }
    if (best?.dist === 0) break;
  }
  const box = best?.node.box;
  if (!best || !box) return null;
  // Span of all nodes of that line inside the same box.
  const same = (box.children ?? []).filter((c) => tags.has(c.tag) && c.line === best.node.line);
  const x0 = Math.min(...same.map((c) => c.x), best.node.x);
  const x1 = Math.max(...same.map((c) => c.x + c.w), best.node.x + 1, x0 + 20);
  return { page: best.page, x: x0, y: box.y - box.h, w: Math.min(x1, box.x + box.w) - x0, h: box.h + box.d };
}

/** PDF -> source: which `file:line` produced the text at (x, y) on `page` (PDF points, top-left origin)? */
export function reverseSearch(index: SyncIndex, page: number, x: number, y: number): { file: string; line: number } | null {
  const nodes = index.pages.get(page);
  if (!nodes) return null;
  let best: { n: SyncNode; area: number } | null = null;
  for (const n of nodes) {
    if (n.kind !== '(' || n.w === 0) continue;
    if (x >= n.x && x <= n.x + n.w && y >= n.y - n.h - 1 && y <= n.y + n.d + 1) {
      const area = n.w * (n.h + n.d + 1);
      if (!best || area < best.area) best = { n, area };
    }
  }
  if (!best) {
    // Click in the margin or between lines: take the vertically nearest text box.
    let nearest: { n: SyncNode; dist: number } | null = null;
    for (const n of nodes) {
      if (n.kind !== '(' || n.w === 0) continue;
      const dist = Math.abs(n.y - (n.h - n.d) / 2 - y);
      if (!nearest || dist < nearest.dist) nearest = { n, dist };
    }
    if (!nearest || nearest.dist > 40) return null;
    best = { n: nearest.n, area: 0 };
  }
  // Prefer the leaf node under the pointer (its line is the source token's line, not the paragraph end's).
  const kids = (best.n.children ?? []).filter(isText);
  let pick: SyncNode = best.n;
  if (kids.length) {
    const left = kids.filter((c) => c.x <= x);
    pick = left.length ? (left[left.length - 1] as SyncNode) : (kids[0] as SyncNode);
  }
  const path = index.inputs.get(pick.tag);
  return path ? { file: path, line: pick.line } : null;
}
