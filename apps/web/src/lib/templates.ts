/**
 * Project templates bundled with the app (src/templates/<id>/). The metadata is small and always available; the
 * files load only when a template is used, so the gallery costs nothing offline or on first paint.
 */
export type TemplateLayout = 'blank' | 'article' | 'report' | 'slides' | 'letter' | 'cv';

export interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  /** Root document, set as the project's main file. */
  main: string;
  order: number;
  layout: TemplateLayout;
}

const metas = import.meta.glob<Omit<TemplateMeta, 'id'>>('../templates/*/meta.json', { eager: true, import: 'default' });
const sources = import.meta.glob<string>(['../templates/*/**/*.tex', '../templates/*/**/*.bib'], { query: '?raw', import: 'default' });

const idOf = (path: string) => path.split('/')[2] as string;

export const TEMPLATES: TemplateMeta[] = Object.entries(metas)
  .map(([path, m]) => ({ ...m, id: idOf(path) }))
  .sort((a, b) => a.order - b.order);

export const DEFAULT_TEMPLATE = 'blank';

/** What applyTemplate needs from the project model. */
export interface TemplateTarget {
  find(path: string): unknown;
  createDir(path: string): string;
  createTextNow(path: string, content?: string): Promise<string>;
  settings: { set(key: string, value: unknown): void };
}

/**
 * Writes a template into a new, empty project: parent folders first, then the files, then the main-file setting.
 * These are ordinary edits, so they sync to peers and to a bound folder like any other change.
 */
export async function applyTemplate(model: TemplateTarget, files: Map<string, string>, main: string): Promise<void> {
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of [...dirs].sort()) if (!model.find(d)) model.createDir(d);
  for (const [path, text] of files) if (!model.find(path)) await model.createTextNow(path, text);
  if (files.has(main)) model.settings.set('main', main);
}

/** The template's files, as project paths → text. Empty for "blank". */
export async function templateFiles(id: string): Promise<Map<string, string>> {
  const prefix = `../templates/${id}/`;
  const entries = Object.entries(sources).filter(([p]) => p.startsWith(prefix));
  const out = new Map<string, string>();
  for (const [p, load] of entries) out.set(p.slice(prefix.length), await load());
  return out;
}
