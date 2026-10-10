import { DEFAULT_IGNORES, createIgnoreMatcher } from '@hivetex/sync';

export class ImportError extends Error {}

/**
 * Normalizes an archive/folder entry name to a POSIX relative path, or throws for anything that could escape
 * the project: absolute paths, drive letters, `..` segments, control characters.
 */
export function safePath(raw: string): string {
  const name = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  const bad = name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\u0000-\u001f\u007f]/.test(name) || name.split('/').some((s) => s === '..');
  if (bad) throw new ImportError(`Unsafe path in archive: ${raw}`);
  return name.split('/').filter((s) => s !== '' && s !== '.').join('/');
}

const OS_JUNK = ['__MACOSX/', '.DS_Store', '._*', 'Thumbs.db', 'desktop.ini'];
const TOOL_DIRS = ['.git/', '.svn/', '.hg/', '.claude/', '.cursor/', '.agents/', '.vscode/', '.idea/', 'node_modules/'];
// `.bbl` is a build artifact for the mirror, but arXiv sources ship it instead of running BibTeX: keep it on import.
const BUILD = DEFAULT_IGNORES.filter((p) => !TOOL_DIRS.includes(p) && !OS_JUNK.includes(p) && p !== '*.bbl');

const isJunk = createIgnoreMatcher(OS_JUNK);
const isTool = createIgnoreMatcher(TOOL_DIRS);
const isBuild = createIgnoreMatcher(BUILD);

export type SkipReason = 'os-metadata' | 'tool-folder' | 'build-artifact' | 'too-large' | 'unsupported';

export const SKIP_LABEL: Record<SkipReason, string> = {
  'os-metadata': 'system metadata',
  'tool-folder': 'version-control / tool folder',
  'build-artifact': 'LaTeX build artifact',
  'too-large': 'file too large',
  unsupported: 'unsupported entry',
};

/** Returns why a path must not be imported, or null to keep it. */
export function skipReason(path: string): SkipReason | null {
  if (isJunk(path)) return 'os-metadata';
  if (isTool(path)) return 'tool-folder';
  if (isBuild(path)) return 'build-artifact';
  return null;
}

/** If every path shares one top-level folder (GitHub / Overleaf downloads), returns that folder name. */
export function commonRoot(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0]?.split('/')[0] as string;
  return paths.every((p) => p.includes('/') && p.split('/')[0] === first) ? first : null;
}
