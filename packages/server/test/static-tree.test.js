import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

// Every file the Node static routes serve (other than the /g/:id page, which nginx also proxies
// to Node) must be in the tree build-static.mjs writes for nginx, byte for byte.
test("the static tree nginx serves matches what the Node static routes serve", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "grill-me-static-"));
  try {
    await promisify(execFile)(process.execPath, [path.join(ROOT, "packages/server/scripts/build-static.mjs"), out]);
    const trees = [
      [path.join(ROOT, "packages/server/public"), out],
      [path.join(ROOT, "packages/ui/src"), path.join(out, "ui")],
      [path.join(ROOT, "packages/core/src"), path.join(out, "core")],
    ];
    let count = 0;
    for (const [src, dst] of trees) {
      for await (const file of walk(src)) {
        const rel = path.relative(src, file);
        if (/\.test\.js$/.test(rel) || /^readme/i.test(path.basename(rel))) continue;
        const built = await readFile(path.join(dst, rel)).catch(() => null);
        assert.ok(built, `missing from static tree: ${rel}`);
        assert.deepEqual(built, await readFile(file), `bytes differ: ${rel}`);
        count++;
      }
    }
    assert.ok(count > 10, "sanity: compared some files");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

// The nginx snippet must proxy exactly the prefixes the Node server answers dynamically
// (/api/ and /g/); every other location must serve the static tree.
test("the nginx snippet's locations match the Node server's routes", async () => {
  const text = async (p) => (await readFile(p, "utf8")).replace(/\r\n/g, "\n"); // tolerate a CRLF checkout
  const snippet = await text(path.join(ROOT, "deploy/nginx/grill-me.ai-locations.conf"));
  const proxyLocations = [...snippet.matchAll(/^location (\S+) \{$/gm)].map((m) => m[1]);
  const proxied = [...snippet.matchAll(/location (\S+) \{\n    proxy_pass http:\/\/127\.0\.0\.1:8787;/g)].map((m) => m[1]);
  assert.deepEqual(proxied.sort(), ["/api/", "/g/"]);
  // No other location proxies.
  assert.equal((snippet.match(/proxy_pass/g) || []).length, 2);
  // The static locations serve from files.
  assert.match(snippet, /location = \/demo \{\n    try_files \/grill\.html =404;/);
  assert.match(snippet, /location \/ \{\n    try_files \$uri \$uri\.html \$uri\/ =404;/);
  // Node's dynamic routes are exactly /api/* and /g/:id.
  const serverSrc = await text(path.join(ROOT, "packages/server/src/server.js"));
  assert.match(serverSrc, /p === "\/api\/g"/);
  assert.match(serverSrc, /pathname\.startsWith\("\/g\/"\)/);
});
