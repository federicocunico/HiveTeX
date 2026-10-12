#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile, chmod, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildWorker } from "./worker-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(here, "worker.config.json"), "utf8"));
const dist = `https://nodejs.org/dist/v${config.node}/`;
const assets = {
  "win32-x64": {
    file: "win-x64/node.exe",
    sha: "bae898add4643fcf890a83ad8ae56e20dce7e781cab161a53991ceba70c99ffb",
  },
  "linux-x64": {
    file: "node-v22.22.0-linux-x64.tar.xz",
    sha: "9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37",
  },
  "darwin-x64": {
    file: "node-v22.22.0-darwin-x64.tar.gz",
    sha: "5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce",
  },
  "darwin-arm64": {
    file: "node-v22.22.0-darwin-arm64.tar.gz",
    sha: "5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640",
  },
};
const root = join(here, "src-tauri/resources/node");
await mkdir(root, { recursive: true });
const universal = process.platform === "darwin"; // Every macOS installer carries both architectures.
const targets = universal
  ? ["darwin-x64", "darwin-arm64"]
  : [`${process.platform}-${process.arch}`];
async function download(file) {
  const r = await fetch(dist + file);
  if (!r.ok) throw new Error(`Node download failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const manifest = { version: config.node, assets: [] };
for (const target of targets) {
  const asset = assets[target];
  if (!asset) throw new Error(`Unsupported shipped worker target: ${target}`);
  const archive = join(root, asset.file.split("/").at(-1));
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch {
    bytes = await download(asset.file);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha)
    throw new Error(`Node checksum mismatch: ${target}`);
  await writeFile(archive, bytes);
  const output = join(
    root,
    universal ? `node-${target.split("-")[1]}` : process.platform === "win32" ? "node.exe" : "node",
  );
  if (target === "win32-x64") {
    if (archive !== output) await copyFile(archive, output);
  } else {
    const extract = join(root, target);
    await mkdir(extract, { recursive: true });
    await promisify(execFile)("tar", ["-xf", archive, "-C", extract, "--strip-components=1"], {
      windowsHide: true,
    });
    await copyFile(join(extract, "bin/node"), output);
    await chmod(output, 0o755);
    await copyFile(join(extract, "LICENSE"), join(root, `LICENSE-${target}.txt`));
    if (!resolve(extract).startsWith(resolve(root) + sep))
      throw new Error("Invalid extraction cleanup path");
    await rm(extract, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
  manifest.assets.push({
    target,
    source: dist + asset.file,
    archiveSha256: asset.sha,
    executableSha256: createHash("sha256")
      .update(await readFile(output))
      .digest("hex"),
  });
}
await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
if (process.platform === "win32") {
  const license = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${config.node}/LICENSE`,
  );
  if (!license.ok) throw new Error("Node license unavailable");
  await writeFile(join(root, "LICENSE.txt"), await license.text());
}
await buildWorker();
console.log(`Packaged Node ${config.node} and sync worker (${targets.join(", ")})`);
