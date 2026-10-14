/**
 * How this device takes part in compilation (per device, all projects):
 * - local: compile here after edits and show only this device's PDFs; never compile for others. The default.
 * - auto:  shared builds (deprecated): compile for the project when this device is the best available (unless "compile
 *          for others" is off), otherwise show the leader's PDFs;
 * - peers: shared builds (deprecated): never compile here (no TeX needed); show the leader's PDFs.
 * Shared builds depend on another device's compiler and connection; field reports (2026-10-14) showed builds failing on
 * customer machines that way, so every device builds its own PDF unless the user picks a shared mode explicitly.
 */
export type CompileMode = 'auto' | 'peers' | 'local';

export const COMPILE_MODE_KEY = 'hivetex.compileMode';
/** Set once the stored mode was moved from the old default (shared) to local. */
export const COMPILE_MODE_MIGRATED_KEY = 'hivetex.compileMode.localDefault';
export const COMPILE_MODES: ReadonlyArray<{ id: CompileMode; label: string; hint: string; deprecated?: boolean }> = [
  { id: 'local', label: 'This device', hint: 'Compile here after edits (recommended)' },
  { id: 'auto', label: 'Shared (deprecated)', hint: 'Deprecated: the best connected device compiles for everyone', deprecated: true },
  { id: 'peers', label: 'Use peers (deprecated)', hint: 'Deprecated: never compile on this device; show the PDFs another device builds', deprecated: true },
];

export interface CompilePolicy {
  /** Detect / load a compiler on this device. */
  loadEngine: boolean;
  /** Not eligible as the project's compile leader. */
  optOut: boolean;
  /** Compile on this device automatically after edits settle. */
  autoLocal: boolean;
  /** Show results produced by the leader. */
  acceptRemote: boolean;
}

/**
 * The device's compile mode: local unless a shared mode was chosen. "Automatic" (shared) was the old default, so a
 * stored `auto` from before is moved to local once; a shared mode chosen after that is kept.
 */
export function readCompileMode(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = safeLocalStorage()): CompileMode {
  let v: string | null | undefined;
  try {
    v = storage?.getItem(COMPILE_MODE_KEY);
    if (v === 'auto' && storage?.getItem(COMPILE_MODE_MIGRATED_KEY) !== '1') {
      storage?.setItem(COMPILE_MODE_KEY, 'local');
      v = 'local';
    }
    storage?.setItem(COMPILE_MODE_MIGRATED_KEY, '1');
  } catch {
    /* storage unavailable: the default applies */
  }
  return v === 'peers' || v === 'auto' ? v : 'local';
}

export function policyFor(mode: CompileMode, compileForOthers: boolean): CompilePolicy {
  switch (mode) {
    case 'peers':
      return { loadEngine: false, optOut: true, autoLocal: false, acceptRemote: true };
    case 'local':
      return { loadEngine: true, optOut: true, autoLocal: true, acceptRemote: false };
    default:
      return { loadEngine: true, optOut: !compileForOthers, autoLocal: false, acceptRemote: true };
  }
}

/**
 * Where an explicit compile request is carried out: this device's own build when it shows only its own results, the
 * leader's build otherwise, and this device's build as well when nobody leads (the request would go unanswered).
 */
export function compileTargets(s: { amLeader: boolean; leaderExists: boolean; autoLocal: boolean; hasEngine: boolean }): {
  runLeader: boolean;
  request: boolean;
  local: boolean;
} {
  if (s.autoLocal) return { runLeader: false, request: false, local: s.hasEngine };
  if (s.amLeader) return { runLeader: true, request: false, local: false };
  if (s.leaderExists) return { runLeader: false, request: true, local: false };
  return { runLeader: false, request: true, local: s.hasEngine };
}

function safeLocalStorage() {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
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
