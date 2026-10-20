import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ImplementationSchema } from "@modelcontextprotocol/core";
import { createServer } from "../src/server.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = path.join(root, "hosted-plugin");
const readJSON = async file => JSON.parse(await fs.readFile(file, "utf8"));
const names = ["grill_start", "grill_send", "grill_wait", "grill_ack", "grill_finish", "grill_cancel", "grill_subscribe", "grill_unsubscribe", "grill_show", "grill_ui_state", "grill_ui_submit"];

test("hosted legacy/modern metadata conforms to published SDK and icon is unauthenticated HTTP SVG", async t => {
  const srv = createServer({ db: ":memory:", log: () => {} });
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  t.after(async () => { srv.server.closeAllConnections(); await srv.close(); });
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  let sequence = 0;
  const rpc = async (method, params = {}, modern = false) => {
    const res = await fetch(base + "/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json",
      ...(modern ? { "mcp-protocol-version": "2026-07-28", "mcp-method": method } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params: { ...params, ...(modern ? { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
      } } : {}) } }) });
    assert.equal(res.status, 200); return (await res.json()).result;
  };
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "metadata test", version: "1" } });
  const discover = await rpc("server/discover", {}, true), tools = await rpc("tools/list", {}, true);
  for (const info of [init.serverInfo, discover._meta["io.modelcontextprotocol/serverInfo"], tools._meta["io.modelcontextprotocol/serverInfo"]]) {
    assert.deepEqual(ImplementationSchema.parse(info), info, "published schema retains every supplied presentation field");
    assert.equal(info.name, "grill-me-game"); assert.equal(info.title, "Grill-me Game");
    assert.equal(info.websiteUrl, "https://grill-me.ai/"); assert.equal(info.version, "0.2.0");
    assert.ok(info.description.length > 20 && info.description.length < 200);
    assert.deepEqual(info, init.serverInfo);
  }
  assert.deepEqual(tools.tools.map(tool => tool.name), names, "tool identifiers remain stable");
  for (const tool of tools.tools) {
    assert.ok(tool.title.length > 4 && !tool.title.includes("_"));
    assert.deepEqual(tool._meta.ui.visibility, tool.name.startsWith("grill_ui_") ? ["app"] : ["model"]);
  }
  const upstream = await fs.readFile(path.join(root, "packages/core/src/grilling.md"), "utf8");
  assert.ok(init.instructions.includes(upstream)); assert.ok(discover.instructions.includes(upstream));
  const iconURL = new URL(init.serverInfo.icons[0].src);
  assert.equal(iconURL.href, "https://grill-me.ai/grill-me-game.svg?v=a27362e00dce");
  const icon = await fetch(base + iconURL.pathname + iconURL.search);
  assert.equal(icon.status, 200); assert.match(icon.headers.get("content-type"), /^image\/svg\+xml/);
  const svg = Buffer.from(await icon.arrayBuffer());
  assert.equal(svg.length, 782);
  assert.equal(createHash("sha256").update(svg).digest("hex"), "a27362e00dcee39a85c5137feefadc8737440786ef9e52863de673d12d00e60a");
  assert.deepEqual(svg, await fs.readFile(path.join(packageRoot, "assets/logo.svg")));
  const favicon = await fetch(base + "/favicon.svg?v=a27362e00dce");
  assert.equal(favicon.status, 200); assert.match(favicon.headers.get("content-type"), /^image\/svg\+xml/);
  assert.deepEqual(Buffer.from(await favicon.arrayBuffer()), svg);
  for (const html of ["index.html", "grill.html", "hub.html"]) {
    assert.match(await fs.readFile(path.join(root, "packages/server/public", html), "utf8"), /href="\/favicon\.svg\?v=a27362e00dce"/);
  }
});

test("portable hosted listing has bounded copy, canonical no-credential transport and safe included assets", async () => {
  const plugin = await readJSON(path.join(packageRoot, "plugin.json")), mcp = await readJSON(path.join(packageRoot, "mcp.json"));
  assert.equal(plugin.name, "grill-me-game"); assert.equal(plugin.version, "0.2.0");
  const ui = plugin.extensions["com.openai"].interface;
  assert.equal(ui.displayName, "Grill-me Game"); assert.ok(ui.displayName.length <= 30);
  for (const [key, limit] of [["shortDescription", 30], ["longDescription", 4000], ["developerName", 80]]) assert.ok(ui[key].length > 0 && ui[key].length <= limit);
  assert.equal(ui.websiteURL, "https://grill-me.ai/"); assert.equal(ui.privacyPolicyURL, "https://grill-me.ai/#privacy");
  assert.equal(ui.supportURL, "https://github.com/hoodoos/grill-me/issues");
  assert.equal(Object.hasOwn(ui, "termsOfServiceURL"), false, "unknown service Terms URL must not be invented");
  assert.ok(ui.defaultPrompt.length > 0 && ui.defaultPrompt.length <= 3);
  for (const prompt of ui.defaultPrompt) assert.ok(prompt.length <= 128 && !prompt.includes("@"));
  assert.deepEqual(mcp.mcpServers, { "grill-me-game": { type: "streamable-http", url: "https://grill-me.ai/mcp" } });
  assert.equal(Object.hasOwn(plugin, "id"), false, "no fabricated registered app identity");
  if (ui.screenshots) assert.equal(ui.screenshots.length, ui.defaultPrompt.length, "one optional screenshot per starter");
  for (const asset of new Set([ui.logo, ui.composerIcon, ...(ui.screenshots ?? [])])) {
    assert.match(asset, /^\.\/assets\/[A-Za-z0-9._-]+$/);
    const filename = path.join(packageRoot, asset), stat = await fs.lstat(filename);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 5 * 1024 * 1024);
    const bytes = await fs.readFile(filename);
    if (asset.endsWith(".svg")) {
      const text = bytes.toString("utf8");
      const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(text);
      assert.equal(width, height); assert.ok(Number(width) >= 48);
      assert.ok(!/<script|<foreignObject|(?:href|src)=|\bon\w+=/i.test(text));
    } else {
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "listing screenshots use PNG");
      assert.equal(bytes.readUInt32BE(16), 706); const height = bytes.readUInt32BE(20);
      assert.ok(height >= 400 && height <= 860);
    }
  }
});
