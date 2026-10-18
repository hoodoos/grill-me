// Writes the exact static tree nginx serves: packages/server/public/* at the root,
// packages/ui/src → ui/, packages/core/src → core/ (no tests, no READMEs).
// Usage: node packages/server/scripts/build-static.mjs <outdir>
import path from "node:path";
import { mkdir, readdir, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SRC, "..", "..", "..");
const out = process.argv[2];
if (!out) {
  console.error("usage: node packages/server/scripts/build-static.mjs <outdir>");
  process.exit(1);
}

const wanted = (name) => !name.endsWith(".test.js") && !/^readme/i.test(name);

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!wanted(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst);
    else if (entry.isFile()) await copyFile(src, dst);
  }
}

await rm(out, { recursive: true, force: true });
await copyTree(path.join(ROOT, "packages", "server", "public"), out);
await copyTree(path.join(ROOT, "packages", "ui", "src"), path.join(out, "ui"));
await copyTree(path.join(ROOT, "packages", "core", "src"), path.join(out, "core"));
console.log(`static tree written to ${out}`);
