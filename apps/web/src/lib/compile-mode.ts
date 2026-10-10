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
