// Run from the repository root: node docs/evidence/authoring/review-compiler-generator.mjs
// Exact generator code, isolated scratch root, no downloads/build/existing dist mutation.
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const temporary = await mkdtemp(join(tmpdir(), 'hivetex-review-generator-'));
if (dirname(resolve(temporary)) !== resolve(tmpdir())) throw new Error('Unexpected scratch path');
try {
  await mkdir(join(temporary, 'scripts'), {recursive:true});
  await writeFile(join(temporary, 'scripts', 'tex-distribution.mjs'), await readFile('scripts/tex-distribution.mjs'));
  await writeFile(join(temporary, 'scripts', 'tex-resource-adapter.js'), await readFile('scripts/tex-resource-adapter.js'));
  // The ready-output branch needs neither archives nor engines.
  await writeFile(join(temporary, 'scripts', 'tex-distribution.lock.json'), JSON.stringify({engines:{}}));
  const generator = await import(pathToFileURL(join(temporary,'scripts','tex-distribution.mjs')));
  const parent = join(temporary,'apps','web','public','texlive');
  await mkdir(join(parent,generator.distributionId), {recursive:true});
  await writeFile(join(parent,generator.distributionId,'manifest.json'), '{}');
  const active = join(parent,'.staging-active-preparation');
  await mkdir(active);
  await writeFile(join(active,'in-progress-resource'), 'live preparation');
  await generator.prepareTexDistribution();
  const survived = await access(active).then(()=>true,()=>false);
  console.log(JSON.stringify({probe:'existing-output preparation deletes another active staging directory', activePreparationSurvived:survived}));
} finally { await rm(temporary,{recursive:true,force:true}); }
