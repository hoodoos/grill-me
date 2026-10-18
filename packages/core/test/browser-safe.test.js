// packages/core runs unchanged in browsers and Node: no node: imports, no bare package imports,
// no Buffer, no process in src.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const srcDir = new URL("../src/", import.meta.url);
const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"));
assert.ok(files.length > 0);

test("no file in packages/core/src uses node:, bare imports, Buffer or process", () => {
  for (const f of files) {
    const code = fs.readFileSync(new URL(f, srcDir), "utf8");
    const where = path.basename(f);
    assert.ok(!/node:/.test(code), `${where}: node: import`);
    for (const m of code.matchAll(/(?:import|export)[^"']*from\s*["']([^"']+)["']/g)) {
      assert.ok(m[1].startsWith("."), `${where}: bare package import "${m[1]}"`);
    }
    for (const m of code.matchAll(/import\s*["']([^"']+)["']/g)) {
      assert.ok(m[1].startsWith("."), `${where}: bare side-effect import "${m[1]}"`);
    }
    assert.ok(!/\bBuffer\b/.test(code), `${where}: Buffer`);
    assert.ok(!/\bprocess\b/.test(code), `${where}: process`);
  }
});
