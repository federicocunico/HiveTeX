import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Final TL2019 packages contain the February 2020 LaTeX/L3 generation used by the vendored format.
// Entire upstream archives are verified before extraction; no current system packages are mixed into this fixture.
const packages: Record<string, string> = {
  latex: '9a5500271084fac6fa184d7f323473cab22a2d93c4b0f1e54f7b33e480fee239',
  amsmath: '8cb9620f2c4561cd02bdab910e6d0d508002d7c1e19d283ca95ce49e574c3193',
  graphics: 'e950eaee2e650cedba0da5508eb01a76854b5cb22a76c507e1accccd15be38c5',
  'graphics-def': '3b03fd1de5e2979960a36a79634773cba905cb8ab3d47c9d7955e557b3b93ceb',
  'graphics-cfg': 'f49fd69ee7b03442e3ce16837e846d1e108e8a71db098fe8eb707c0e3d8e2c6c',
  l3backend: 'e0e74b38a739576a32bd8e964b7201ff949ea8908eb4eda78579f592dca42590',
  l3kernel: 'cedbd51f98f65742d63fe1cd61b6e9ec109df410c032679023f4a1936157693c',
  cm: 'b6ab07931636348df2059df8f3a60f6ad978ed3614e7a3ada190cb8ba4d13302',
  ec: 'bb85425c214b1056b5f0b8f3bf1478b81e89bd7d290d61c7c73289b534786897',
  'cm-super': '70867904e38451ab1a11ba4677dd5891914f128170b53fac26d3e9dca9d326e4',
  amsfonts: 'fec4b4df7f3c49e74b5592e19b41949fa6413e5fa91e46fe255de083e6601666',
  'latex-fonts': 'c542058e4dc1dfedc36bd65c44b472f69cf1d85bf271090cb10f698e901ebdbf',
  bibtex: '7b4c032e1fbf6b0af9b063ad1edeeb020acbf3235ee1cb83a71f3efdad7659d1',
  pdftex: '797165be30247bc8230abb6f11d9b5d9f85b8c9302c6c98a5fcad31c842bad35',
  'hyphen-base': '79d4b1cc33ad9a140041e7a2218da06e550af65c032acc1985ba501e3b304bf7',
  'tex-ini-files': '6569ec35c603a770f762e1783f79cfd8171b0eb919d06d806d2280829a6582bd',
};

export async function texlive2019() {
  const dir = join(tmpdir(), 'hivetex-texlive-2019'), tree = join(dir, 'tree-v1');
  await mkdir(tree, { recursive: true });
  for (const [name, sha] of Object.entries(packages)) {
    const archive = join(dir, `${name}.tar.xz`);
    let bytes = await readFile(archive).catch(() => undefined);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha) {
      const url = `https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2019/tlnet-final/archive/${name}.tar.xz`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Pinned ${name}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error(`Checksum mismatch: ${name}`);
      await writeFile(archive, bytes);
    }
    const extract = spawnSync('tar', ['-xf', archive, '-C', tree], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (extract.status !== 0) throw new Error(`Extract ${name}: ${extract.stderr}`);
  }
  const files = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, file.name);
      if (file.isDirectory()) await walk(path);
      else files.set(basename(path), path);
    }
  };
  await walk(tree);
  // TeX Live creates this map at install time from the fonts in this resource set.
  const map = Buffer.concat(await Promise.all(['cm.map', 'cmextra.map', 'latxfont.map', 'symbols.map', 'cm-super-ts1.map'].map((name) => readFile(files.get(name)!))));
  return async (name: string): Promise<Buffer | undefined> => {
    if (name === 'pdftex.map') return map;
    const path = files.get(name) ?? files.get(`${name}.tfm`);
    return path ? readFile(path) : undefined;
  };
}
