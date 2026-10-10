export type ToastKind = 'info' | 'ok' | 'error';
export type Toast = { id: number; text: string; kind: ToastKind };

/** Transient confirmations ("Invitation copied"). Read by <Toaster />, which announces them politely. */
export const toasts = $state<Toast[]>([]);
let next = 1;

export function toast(text: string, kind: ToastKind = 'ok', ms = 3500): number {
  const id = next++;
  toasts.push({ id, text, kind });
  setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}
