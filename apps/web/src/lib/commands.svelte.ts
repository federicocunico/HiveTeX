import type { Files } from '../ui/icons.js';
import { matchesKey } from '../ui/keys.js';

/** Any icon from ui/icons.ts. */
export type IconComponent = typeof Files;

/**
 * The one list of actions. The command palette, keyboard shortcuts, menus and the shortcut reference all read it,
 * so a label or a shortcut cannot differ between them. Screens register their commands while mounted.
 */
export type CommandGroup = 'Compile' | 'Project' | 'Files' | 'View' | 'Navigate' | 'Insert' | 'Account' | 'Help';

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** Shortcuts, first one shown; "Mod" is Ctrl, or Cmd on a Mac. */
  keys?: string[];
  /** Other words people may type for it (e.g. old labels). */
  aliases?: string[];
  icon?: IconComponent;
  /** Available right now (role, screen state). Missing means always. */
  when?: () => boolean;
  /** Bound inside the source editor only (the editor dispatches it), never as a page-wide shortcut. */
  editor?: boolean;
  /** Hidden from the palette (e.g. "open the palette"). */
  hidden?: boolean;
  run: () => void;
}

// Raw (not deeply reactive): commands keep their identity, so unregistering finds them. Changes reassign the list.
let registry = $state.raw<{ list: Command[] }>({ list: [] });

/** Registers commands until the returned function is called (call it when the screen unmounts). */
export function registerCommands(cmds: Command[]): () => void {
  const ids = new Set(cmds.map((c) => c.id));
  registry = { list: [...registry.list.filter((x) => !ids.has(x.id)), ...cmds] };
  return () => {
    registry = { list: registry.list.filter((x) => !cmds.includes(x)) };
  };
}

export function allCommands(): Command[] {
  return registry.list;
}

/** Commands available now. */
export function availableCommands(): Command[] {
  return registry.list.filter((c) => !c.when || c.when());
}

export function runCommand(id: string): boolean {
  const c = registry.list.find((x) => x.id === id);
  if (!c || (c.when && !c.when())) return false;
  c.run();
  return true;
}

/** The page-wide command for a key event, if any (editor-only commands are left to the editor). */
export function commandForKey(e: KeyboardEvent): Command | undefined {
  return registry.list.find((c) => !c.editor && c.keys?.some((k) => matchesKey(e, k)) && (!c.when || c.when()));
}

/**
 * The command for a key event inside the source editor: editor-only commands first, then page-wide ones, so
 * Ctrl+Enter compiles instead of inserting a line. The editor asks at keydown time, so commands registered later
 * still apply.
 */
export function editorCommandForKey(e: KeyboardEvent): Command | undefined {
  const hit = (c: Command) => c.keys?.some((k) => matchesKey(e, k)) && (!c.when || c.when());
  return registry.list.find((c) => c.editor && hit(c)) ?? registry.list.find((c) => !c.editor && hit(c));
}

// ---- palette sources: files, outline headings, projects, line numbers ----

export interface PaletteItem {
  id: string;
  title: string;
  /** Secondary text on the right (path, location). */
  detail?: string | undefined;
  icon?: IconComponent | undefined;
  /** Heading in the file open in the editor (the "@" filter). */
  inOpenFile?: boolean;
  run: () => void;
}

export interface PaletteSource {
  id: 'files' | 'outline' | 'projects';
  label: string;
  items: () => PaletteItem[];
}

let sources = $state.raw<{ list: PaletteSource[]; gotoLine: ((line: number) => void) | null }>({ list: [], gotoLine: null });

export function registerSource(s: PaletteSource): () => void {
  sources = { ...sources, list: [...sources.list.filter((x) => x.id !== s.id), s] };
  return () => {
    sources = { ...sources, list: sources.list.filter((x) => x !== s) };
  };
}

export function paletteSources(): PaletteSource[] {
  return sources.list;
}

/** What ":120" does: set by the workspace while an editor is open. */
export function setGotoLine(fn: ((line: number) => void) | null) {
  sources = { ...sources, gotoLine: fn };
}

export function gotoLineHandler() {
  return sources.gotoLine;
}
