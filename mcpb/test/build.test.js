// Builds dist/grill-me.mcpb, unpacks it with the mcpb tool and checks the unpacked server
// answers MCP initialize and tools/list. Set GRILL_ME_SKIP_PACK=1 to skip (no network).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mcpbFile = path.join(repoRoot, "mcpb", "dist", "grill-me.mcpb");

const mcpb = (args) => {
  const r = spawnSync("npx", ["-y", "@anthropic-ai/mcpb@2.1.2", ...args], {
    shell: process.platform === "win32", // npx is a .cmd on Windows
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test(
  "the Claude Desktop extension builds, unpacks and serves MCP",
  { skip: !!process.env.GRILL_ME_SKIP_PACK, timeout: 300_000 },
  async (t) => {
    const build = spawnSync(process.execPath, [path.join(repoRoot, "mcpb", "build.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    assert.ok(fs.existsSync(mcpbFile), "dist/grill-me.mcpb exists");

    const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "grill-me-mcpb-"));
    t.after(() => fs.rmSync(unpacked, { recursive: true, force: true }));
    mcpb(["unpack", mcpbFile, unpacked]);
    assert.ok(fs.existsSync(path.join(unpacked, "manifest.json")), "manifest.json unpacked");
    const entry = path.join(unpacked, "server", "index.js");
    assert.ok(fs.existsSync(entry), "server/index.js unpacked");

    const replies = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let done = false;
      const fail = (err) => {
        if (!done) {
          done = true;
          reject(err);
        }
      };
      child.on("error", fail);
      child.on("close", (code) => fail(new Error(`server exited early (${code}): ${out}`)));
      child.stdout.on("data", (d) => {
        out += d;
        const lines = out.split("\n").filter(Boolean);
        if (lines.length >= 2 && !done) {
          done = true;
          child.kill();
          try {
            resolve(lines.map((l) => JSON.parse(l)));
          } catch (err) {
            reject(err);
          }
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb-test", version: "0" } },
        }) + "\n",
      );
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    });
    assert.equal(replies[0].result.serverInfo.name, "grill-me");
    const tools = replies[1].result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, ["grill_cancel", "grill_send", "grill_wait"]);
  },
);
