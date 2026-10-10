/**
 * Copies text. The Clipboard API first; when it is missing, refuses or never answers (seen in WebKitGTK, the Linux
 * desktop app's webview), the classic copy command on a hidden text area. Throws when neither works.
 */
export async function copyText(text: string, timeoutMs = 1500): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no Clipboard API');
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), timeoutMs)),
    ]);
    return;
  } catch {
    /* fall back below */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  const prev = document.activeElement as HTMLElement | null;
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  prev?.focus();
  if (!ok) throw new Error('Copying is not allowed here');
}
