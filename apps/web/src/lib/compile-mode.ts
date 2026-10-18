/** Every build runs on this machine. Legacy shared preferences are migrated once. */
export type CompileMode = 'local';
export const COMPILE_MODE_KEY = 'hivetex.compileMode';
const MIGRATION_NOTICE_KEY = 'hivetex.compileMigrationNotice';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function safeLocalStorage(): PreferenceStorage | undefined {
  try { return localStorage; } catch { return undefined; }
}

export function readCompileMode(storage: PreferenceStorage | undefined = safeLocalStorage()): CompileMode {
  try {
    const old = storage?.getItem(COMPILE_MODE_KEY);
    if (old === 'auto' || old === 'peers') {
      storage?.setItem(COMPILE_MODE_KEY, 'local');
      storage?.setItem(MIGRATION_NOTICE_KEY, '1');
    }
  } catch { /* local builds still apply when preferences cannot be stored */ }
  return 'local';
}

/** Whether the one-time explanation is still owed. Reading does not consume it: it stays until the member dismisses it. */
export function compileMigrationPending(storage: PreferenceStorage | undefined = safeLocalStorage()): boolean {
  try { return storage?.getItem(MIGRATION_NOTICE_KEY) === '1'; } catch { return false; }
}

export function dismissCompileMigrationNotice(storage: PreferenceStorage | undefined = safeLocalStorage()) {
  try { if (storage?.getItem(MIGRATION_NOTICE_KEY) === '1') storage.setItem(MIGRATION_NOTICE_KEY, '0'); } catch { /* shown again next time */ }
}

/** Human name of a native compiler flavor reported by the desktop app. */
export function compilerLabel(flavor: string): string {
  if (flavor.startsWith('tectonic')) return 'quick compiler';
  if (flavor.startsWith('tinytex')) return 'full LaTeX';
  if (flavor === 'miktex') return 'MiKTeX';
  if (flavor === 'texlive') return 'TeX Live';
  return flavor || 'LaTeX';
}

/** A short explanation when a build failed because a package is missing (the raw log stays available). */
export function missingPackageHint(log: string, compilerName: string): string | null {
  const m = /! LaTeX Error: File `([^']+)' not found/.exec(log);
  if (!m) return null;
  const file = m[1] as string;
  const pkg = file.replace(/\.(sty|cls)$/, '');
  if (compilerName === 'full LaTeX') return `The package "${pkg}" could not be installed (no TeX Live package provides ${file}, or the download failed). Check its name, or try again when online.`;
  if (compilerName === 'quick compiler') return `The quick compiler has no package "${pkg}". Install full LaTeX in Account > Compiler to get every TeX Live package, or check the name.`;
  if (compilerName === 'in-browser compiler') return `The in-browser compiler could not load "${pkg}". Install the HiveTeX desktop app (it compiles with every package), or check the name.`;
  return `The package "${pkg}" is not installed on the compiling computer (${file}). Install it with your TeX distribution's package manager, or check the name.`;
}
