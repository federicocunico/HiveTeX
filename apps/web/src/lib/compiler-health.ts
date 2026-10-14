import { compilerLabel } from './compile-mode.js';

/**
 * The desktop's compiler check (apps/desktop/src-tauri/src/compiler_health.rs): at every start it compiles a minimal
 * document and, when that fails, repairs the compiler (clears caches, installs a managed compiler again, sets a broken
 * system TeX aside). Account > Compiler shows the last result; a start that repaired or could not repair says so.
 */
export interface CompilerHealth {
  state: 'ok' | 'repaired' | 'failed' | 'offline' | 'none';
  compiler: string | null;
  steps: string[];
  log: string;
  at: number;
}

/** One line for the user, or null when there is nothing to say. */
export function healthMessage(h: CompilerHealth | null): string | null {
  if (!h) return null;
  const name = h.compiler ? compilerLabel(h.compiler) : 'LaTeX';
  switch (h.state) {
    case 'ok':
      return `Compiler check passed (${name}).`;
    case 'repaired':
      return `The compiler did not work and was repaired: ${h.steps.join('; ')}. It now compiles with ${name}.`;
    case 'failed':
      return `The compiler (${name}) does not work and could not be repaired (${h.steps.join('; ') || 'nothing to try'}). Install full LaTeX below, or check your TeX installation.`;
    case 'offline':
      return `The compiler check could not download packages (offline?). It runs again at the next start, or with Check now.`;
    case 'none':
      return null;
  }
}

/** A system TeX was set aside by the check (the user can use it again). */
export const setSystemTexAside = (h: CompilerHealth | null) => !!h && h.state === 'repaired' && h.steps.some((s) => s.startsWith('set the system TeX'));

/** Desktop: announces a start-up check that repaired or could not repair the compiler. */
export async function watchCompilerHealth(notify: (text: string, kind: 'info' | 'error') => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<CompilerHealth>('compiler://health', (e) => {
    const h = e.payload;
    if (h.state === 'repaired' || h.state === 'failed') notify(healthMessage(h) ?? '', h.state === 'failed' ? 'error' : 'info');
  });
}
