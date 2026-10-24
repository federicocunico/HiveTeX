import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { texlive2019 } from './texlive-2019.js';

/** Real TeX package server for acceptance tests. Only package names reach it; the WASM worker builds the PDF. */
export async function texFixture(options: { pinned?: boolean } = {}) {
  const pinned = options.pinned ? await texlive2019() : null;
  const sha = '3134ef8cbfa829780fc0b63b5320fb680e8f895f0c7f48ecb82af159098760ec';
  const url = 'https://raw.githubusercontent.com/SwiftLaTeX/Texlive-Ondemand/cc2146e220658f5ee0f8643355252ae0995fbc98/swiftlatexpdftex.fmt';
  const dir = join(tmpdir(), 'hivetex-swiftlatex-fixtures'), path = join(dir, 'swiftlatexpdftex.fmt');
  await mkdir(dir, { recursive: true });
  let format = await readFile(path).catch(() => undefined);
  if (!format || createHash('sha256').update(format).digest('hex') !== sha) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot fetch pinned WASM format: ${response.status}`);
    format = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(format).digest('hex') !== sha) throw new Error('WASM format checksum mismatch');
    await writeFile(path, format);
  }
  const backendDir = join(dir, 'latex3-9f7051e8e63cb36313664ac2bdaca6b015bfb8b9');
  const backend = join(backendDir, 'l3backend', 'l3backend-pdfmode.def');
  if (!pinned) {
  const check = spawnSync('kpsewhich', ['article.cls'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (check.status !== 0 || !check.stdout.trim()) throw new Error('Real WASM acceptance requires kpsewhich and TeX package files; install TinyTeX or MiKTeX');
  // Match the L3 backend to the preloaded 2020-02-14 kernel. Current TeX installations renamed this backend and
  // are not a compatible package server for the pinned format. Generate it from the complete pinned LPPL bundle.
  if (!await readFile(backend).catch(() => undefined)) {
    const archive = join(dir,'latex3-2020.tar.gz');
    const expected = '2954bf4f4bae7d559b1eaa294adb6a601608291695f038b6a6ad2283d0f71623';
    let bytes = await readFile(archive).catch(() => undefined);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
      const response = await fetch('https://codeload.github.com/latex3/latex3/tar.gz/9f7051e8e63cb36313664ac2bdaca6b015bfb8b9',{signal:AbortSignal.timeout(30_000)});
      if (!response.ok) throw new Error('Cannot fetch pinned L3 backend bundle');
      bytes=Buffer.from(await response.arrayBuffer());
      if(createHash('sha256').update(bytes).digest('hex')!==expected) throw new Error('L3 bundle checksum mismatch');
      await writeFile(archive,bytes);
    }
    const unpack = spawnSync('tar',['-xzf',archive,'-C',dir],{windowsHide:true,encoding:'utf8',timeout:30_000});
    if(unpack.status!==0) throw new Error(`Cannot unpack L3 fixture: ${unpack.stderr}`);
    const generate = spawnSync('tex',['-no-shell-escape','-interaction=nonstopmode','l3backend.ins'],{cwd:join(backendDir,'l3backend'),windowsHide:true,encoding:'utf8',timeout:30_000,env:{...process.env,TEXINPUTS:`../l3kernel//${process.platform==='win32'?';':':'}`}});
    if(generate.status!==0) throw new Error(`Cannot generate compatible backend: ${generate.stdout}\n${generate.stderr}`);
  }
  }
  const requests: string[] = [];
  let resume: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const server = createServer(async (request, response) => {
    if (gate) await gate;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Expose-Headers', 'fileid, pkid');
    response.setHeader('Content-Type', 'application/octet-stream');
    const parts = new URL(request.url!, 'http://localhost/').pathname.split('/');
    const name = decodeURIComponent(parts.pop() ?? '');
    const formatId = Number(parts.pop());
    const lookup = name.includes('.') ? name : `${name}${formatId === 7 ? '.bst' : formatId === 6 ? '.bib' : formatId === 3 ? '.tfm' : ''}`;
    requests.push(name);
    if (!/^[a-zA-Z0-9_.+-]+$/.test(name)) { response.writeHead(404).end(); return; }
    try {
      let bytes: Buffer | undefined;
      if (name === 'swiftlatexpdftex.fmt') bytes = format;
      else if (pinned) bytes = await pinned(lookup);
      else if (name === 'l3backend-pdfmode.def') bytes = await readFile(backend);
      else {
        const found = spawnSync('kpsewhich', [lookup], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
        const file = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : undefined;
        if (file) bytes = await readFile(file);
      }
      if (!bytes) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Length', bytes.length);
      // The worker stores each resource under this ID. Without it every file aliases /tex/null.
      response.setHeader('fileid', createHash('sha256').update(bytes).digest('hex'));
      response.setHeader('pkid', createHash('sha256').update(bytes).digest('hex'));
      response.writeHead(200).end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Package fixture failed to start');
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}/`, requests,
    pause: () => { gate ??= new Promise<void>((resolve) => { resume = resolve; }); },
    resume: () => { resume?.(); resume = null; gate = null; },
    close: () => { resume?.(); gate = null; if (closed) return Promise.resolve(); closed = true; return new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((e) => e ? reject(e) : resolve()); }); },
  };
}
