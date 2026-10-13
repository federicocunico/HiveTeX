import { type BrowserContext, test as base } from '@playwright/test';

type Step = { t: number; self: string; ev: string; dev?: string; data?: Record<string, string | number | boolean> };

/** One line per step, like the unit tests print: `+  123 ms  a-device -> z-device  sig.send  k=offer`. */
function format(label: string, steps: Step[]): string {
  const start = steps[0]?.t ?? 0;
  const lines = steps.map((e) => {
    const data = e.data ? ` ${Object.entries(e.data).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
    return `+${String(e.t - start).padStart(6)} ms  ${(e.dev ? `${e.self} -> ${e.dev}` : e.self).padEnd(24)} ${e.ev}${data}`;
  });
  return [`connection trace of ${label}`, ...lines].join('\n');
}

/**
 * Every Playwright test that exercises sync gets the connection trace of each open page attached when it fails, so the
 * step where connecting stopped is visible without re-running (spec network-diagnostics › Sync tests print the trace).
 * Specs import `test` from here instead of `@playwright/test`.
 */
export const test = base.extend<{ connectionTrace: void }>({
  connectionTrace: [
    async ({ browser, context }, use, testInfo) => {
      const contexts: BrowserContext[] = [context];
      const original = browser.newContext.bind(browser);
      browser.newContext = (async (...args: Parameters<typeof original>) => {
        const c = await original(...args);
        contexts.push(c);
        return c;
      }) as typeof browser.newContext;
      await use();
      browser.newContext = original;
      if (testInfo.status === testInfo.expectedStatus) return;
      let n = 0;
      for (const c of contexts) {
        for (const page of c.pages()) {
          n++;
          const steps = await page
            .evaluate(() => {
              const s = (window as unknown as { __p2p?: { session?: { syncDiagnostics?: () => { trace?: unknown[] } } } }).__p2p?.session;
              return (s?.syncDiagnostics?.().trace ?? []) as Array<unknown>;
            })
            .catch(() => []);
          const label = `page ${n} (${page.url().replace(/#.*/, '#…')})`;
          await testInfo.attach(`connection-trace-${n}.txt`, {
            body: steps.length ? format(label, steps as Step[]) : `${label}: no connection steps recorded (no project open, or the page is gone)`,
            contentType: 'text/plain',
          });
          if (steps.length) console.error(`\n${format(label, steps as Step[])}\n`);
        }
      }
    },
    { auto: true },
  ],
});
