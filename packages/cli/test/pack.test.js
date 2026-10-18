// Builds dist/grill-me-ai with scripts/pack.mjs, npm-installs the tarball into a temp folder and
// checks the installed bin, the ./core subpath export and that no test files ship.
// Runs in CI; skip locally with GRILL_ME_SKIP_PACK=1.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(cliDir, "scripts", "pack.mjs");

const sh = (cmd, args, { shell = false, ...opts } = {}) => {
  // shell only where Windows needs it (npm and the .cmd shim); it breaks paths with spaces otherwise
  const r = spawnSync(cmd, args, { shell: shell && process.platform === "win32", encoding: "utf8", ...opts });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};

test("the packed tarball installs and works", { skip: !!process.env.GRILL_ME_SKIP_PACK, timeout: 180_000 }, (t) => {
  const tarball = sh(process.execPath, [PACK]);
  t.after(() => fs.rmSync(path.join(cliDir, "dist"), { recursive: true, force: true }));

  const listing = sh("tar", ["--force-local", "-tzf", tarball]);
  assert.ok(listing.includes("package/packages/cli/bin/grill-me.js"), "bin ships");
  assert.ok(listing.includes("package/packages/core/src/index.js"), "core ships");
  assert.ok(!/(^|\n)package\/.*(test|scripts)\//.test(listing), "no test or script files ship");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grill-me-pack-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "pack-test", private: true }));
  sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], { cwd: tmp, shell: true });

  const bin = path.join(tmp, "node_modules", ".bin", process.platform === "win32" ? "grill-me.cmd" : "grill-me");
  const version = sh(bin, ["--version"], { cwd: tmp, shell: true });
  assert.equal(version, "0.1.0");

  const check = sh(process.execPath, [
    "--input-type=module",
    "-e",
    `const m = await import("grill-me-ai/core"); if (typeof m.convert !== "function") process.exit(1); console.log("core ok");`,
  ], { cwd: tmp });
  assert.equal(check, "core ok");
});
