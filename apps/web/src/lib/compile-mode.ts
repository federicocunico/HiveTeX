/**
 * How this device takes part in compilation (per device, all projects):
 * - auto:  compile for the project when this device is the best available (unless "compile for others" is off);
 * - peers: never compile here (no TeX needed, no in-browser compiler download); show the leader's PDFs;
 * - local: compile here after edits and show only this device's PDFs; never compile for others.
 */
export type CompileMode = 'auto' | 'peers' | 'local';

export const COMPILE_MODE_KEY = 'hivetex.compileMode';
export const COMPILE_MODES: ReadonlyArray<{ id: CompileMode; label: string; hint: string }> = [
  { id: 'auto', label: 'Automatic', hint: 'The best connected device compiles for everyone' },
  { id: 'peers', label: 'Use peers', hint: 'Never compile on this device; no LaTeX needed' },
  { id: 'local', label: 'This device only', hint: 'Compile here after edits; results are not shared' },
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

export function readCompileMode(storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage()): CompileMode {
  const v = storage?.getItem(COMPILE_MODE_KEY);
  return v === 'peers' || v === 'local' ? v : 'auto';
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
