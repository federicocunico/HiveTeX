import { onTestFailed, onTestFinished } from 'vitest';
import { TraceLog } from '@hivetex/sync/testing';

let current: TraceLog | null = null;

/** The connection trace of the running test; the first call registers printing it when the test fails. */
export function traceLog(): TraceLog {
  if (current) return current;
  const log = new TraceLog();
  current = log;
  onTestFailed(() => console.error(`\n${log.format()}\n`));
  onTestFinished(() => {
    if (current === log) current = null;
  });
  return log;
}
