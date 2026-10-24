import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** A unique test executable makes the supported WebView2 policy override app-specific and disposable. */
export async function nativeWebview(appExe, port) {
  const name = `hivetex-authoring-${randomUUID()}.exe`;
  const exe = join(dirname(appExe), name);
  const profile = await mkdtemp(join(tmpdir(), 'hivetex-authoring-webview-'));
  const key = 'HKCU\\Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
  const args = `--remote-debugging-port=${port}`;
  const reg = (...values) => spawnSync('reg.exe', values, { encoding: 'utf8', windowsHide: true });
  let policy = false;
  const dispose = async () => {
    if (policy && reg('delete', key, '/v', name, '/f').status !== 0) throw new Error('Could not remove the isolated WebView2 debug policy');
    policy = false;
    await rm(exe, { force: true });
    if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('hivetex-authoring-webview-')) throw new Error('Unexpected WebView2 test profile path');
    // WebView2 may finish lazy profile cleanup after its owning app exits.
    await rm(profile, { recursive: true, force: true }).catch((error) => console.warn(`Test WebView2 profile cleanup: ${error.code}`));
  };
  try {
    await copyFile(appExe, exe);
    // Hosted Windows runners are administrators. Local standard-user runs use the documented environment mechanism.
    if (process.env.GITHUB_ACTIONS === 'true') {
      if (reg('query', key, '/v', name).status === 0) throw new Error('Refusing to replace an existing WebView2 debug policy');
      const result = reg('add', key, '/v', name, '/t', 'REG_SZ', '/d', args, '/f');
      if (result.status !== 0) throw new Error(`Could not configure isolated WebView2 debugging: ${result.stderr}`);
      policy = true;
    }
    return { exe, policy, env: { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args, WEBVIEW2_USER_DATA_FOLDER: profile }, dispose };
  } catch (error) { await dispose(); throw error; }
}
