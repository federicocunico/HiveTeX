import type { Diagnostic } from './logparser.js';

export interface CompileFailure {
  kind: 'compiler' | 'engine' | 'input' | 'package' | 'source' | 'timeout' | 'runtime';
  summary: string;
  recovery: string;
  action: 'setup' | 'retry' | 'source' | 'sync';
}

/** Preserve concrete causes even when TeX never reached a source line. No raw-log inspection is required. */
export function explainFailure(log: string, diagnostics: Diagnostic[] = [], missing: string[] = []): CompileFailure {
  if (missing.length) return { kind: 'input', summary: `Project inputs are unavailable: ${missing.join(', ')}.`, recovery: 'Reconnect to a co-author or restore these files, then retry.', action: 'sync' };
  const unsupported = /cannot run (\w+)|([A-Za-z]+LaTeX) is not available/i.exec(log);
  if (unsupported) return { kind: 'engine', summary: `${unsupported[1] ?? unsupported[2]} is unavailable on this device.`, recovery: 'Set up a compatible compiler in Account > Compiler, or select an installed engine in project settings.', action: 'setup' };
  if (/set up (?:a local|the quick) compiler|no (?:LaTeX|TeX|local compiler)|could not be set up|compiler.*unavailable|format.*not cached|TeX (?:file|package) server.*(?:unavailable|unreachable)/i.test(log)) {
    return { kind: 'compiler', summary: 'The local compiler is not ready.', recovery: log.replace(/^!\s*/, '') || 'Open Account > Compiler to finish setup, then retry.', action: 'setup' };
  }
  const packageName = /File\s+[`']([^`'\n]+\.(?:sty|cls|def|tfm|fmt))['`]?\s+not found/i.exec(log)?.[1];
  if (packageName || /(?:download|fetch|acquir|install).*(?:fail|HTTP|offline)|package.*(?:fail|unavailable)|format.*incompatib/i.test(log)) {
    return { kind: 'package', summary: packageName ? `Compiler dependency missing: ${packageName}.` : 'A compiler dependency could not be loaded.', recovery: 'Check the connection and package server, then retry. Account > Compiler offers setup and cache recovery.', action: 'retry' };
  }
  if (/timed? out|timeout/i.test(log)) return { kind: 'timeout', summary: 'Compilation exceeded its time limit.', recovery: 'Check the source for loops or unusually expensive work, then retry.', action: 'retry' };
  const diagnostic = diagnostics.find((d) => d.severity === 'error');
  if (diagnostic) return { kind: 'source', summary: diagnostic.message, recovery: diagnostic.line ? `Check ${diagnostic.file || 'the main document'}, line ${diagnostic.line}, and correct the source.` : 'Check the source and project file names, then retry.', action: 'source' };
  const cause = log.split(/\r?\n/).find((line) => /^!/.test(line))?.replace(/^!\s*/, '').replace(/^Local compile failed:\s*/, '');
  return { kind: 'runtime', summary: cause || 'The local build failed before producing a PDF.', recovery: 'Retry the build. If it fails again, inspect the raw log or open Account > Compiler.', action: 'retry' };
}
