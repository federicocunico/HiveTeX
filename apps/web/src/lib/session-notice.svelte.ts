export const sessionNotice = $state<{ message: string; retry: (() => Promise<unknown>) | null; busy: boolean }>({ message: '', retry: null, busy: false });
export async function retryRememberedSession() {
  if (!sessionNotice.retry || sessionNotice.busy) return;
  sessionNotice.busy = true;
  try { await sessionNotice.retry(); } finally { sessionNotice.busy = false; }
}
