import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** Use a fresh browser profile and an explicit test-feature CDP argument, isolated from product builds. */
export async function nativeWebview(appExe, port) {
  const name = `hivetex-authoring-${randomUUID()}.exe`;
  const exe = join(dirname(appExe), name);
  const profile = await mkdtemp(join(tmpdir(), 'hivetex-authoring-webview-'));
  const dispose = async () => {
    await rm(exe, { force: true });
    if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('hivetex-authoring-webview-')) throw new Error('Unexpected WebView2 test profile path');
    // WebView2 may finish lazy profile cleanup after its owning app exits.
    await rm(profile, { recursive: true, force: true }).catch((error) => console.warn(`Test WebView2 profile cleanup: ${error.code}`));
  };
  try {
    await copyFile(appExe, exe);
    return { exe, env: { HIVETEX_TEST_CDP_PORT: String(port), WEBVIEW2_USER_DATA_FOLDER: profile }, dispose };
  } catch (error) { await dispose(); throw error; }
}
