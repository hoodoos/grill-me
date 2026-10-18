// Spawns `grill-me mcp` against the fake server and drives it with newline-delimited JSON-RPC.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_TEXT } from "../../core/src/index.js";
import { startFakeServer } from "./fake-server.js";
import { phoneAnswer } from "./phone.js";

const BIN = fileURLToPath(new URL("../bin/grill-me.js", import.meta.url));

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.lines = [];
    this.stderr = "";
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        this.lines.push(line);
        const msg = JSON.parse(line); // every stdout line must be valid JSON(-RPC)
        assert.equal(msg.jsonrpc, "2.0", `stdout line is JSON-RPC: ${line}`);
        if ("id" in msg && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    child.stderr.on("data", (d) => (this.stderr += d));
  }
  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }
  request(method, params) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`${method}: no response within 30 s`)), 30_000);
    });
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
}

async function fixture(t, { clientName = "Claude Code" } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "grill-me-mcp-"));
  const fake = await startFakeServer();
  const child = spawn(process.execPath, [BIN, "mcp"], {
    env: { ...process.env, GRILL_ME_HOME: home, GRILL_ME_SERVER: fake.url },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const mcp = new McpClient(child);
  t.after(async () => {
    child.kill();
    await fake.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const init = await mcp.request("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: clientName, version: "1.0" },
  });
  assert.equal(init.result.serverInfo.name, "grill-me");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  mcp.notify("notifications/initialized");
  return { home, fake, child, mcp };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("initialize → tools/list → grill_send → phone answers → grill_wait → ANSWERS", async (t) => {
  const { home, fake, mcp } = await fixture(t);

  const list = await mcp.request("tools/list");
  assert.deepEqual(list.result.tools.map((x) => x.name), ["grill_send", "grill_wait", "grill_cancel"]);

  const sent = await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
  const { id, link, qr, count, expiresAt } = sent.result.structuredContent;
  assert.match(id, /^[A-Za-z0-9_-]{16}$/);
  assert.match(link, new RegExp(`^${fake.url}/g/`));
  assert.ok(qr.includes("█"));
  assert.equal(count, 4);
  assert.equal(typeof expiresAt, "number");
  assert.ok(sent.result.content[0].text.includes("```"), "the QR is fenced in the text");

  // the metrics user-agent carries the mapped MCP client name
  const creates = fake.requests().filter((x) => x.method === "POST" && x.path === "/api/g");
  assert.equal(creates.at(-1).userAgent, "grill-me-ai/0.1.0 (claude-code)");

  const pending = JSON.parse(await fs.readFile(path.join(home, "pending", `${id}.json`), "utf8"));
  const answering = sleep(200).then(() =>
    phoneAnswer(fake.url, id, pending.secret, [
      { n: 1, kind: "agree" },
      { n: 2, kind: "choice", choice: "Always dark" },
      { n: 3, kind: "own", text: "Three days." },
      { n: 4, kind: "skip" },
    ]),
  );
  const waited = await mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: 10 } });
  await answering;
  assert.equal(waited.result.structuredContent.status, "ANSWERS");
  assert.match(waited.result.structuredContent.answers, /Q2 - Always dark/);
  assert.ok(waited.result.content[0].text.endsWith("STATUS: ANSWERS"));
  assert.equal(fake.grill(id), undefined, "the grill was deleted after ANSWERS");
});

test("grill_wait with seconds: 1 returns WAITING", async (t) => {
  const { fake, mcp } = await fixture(t);
  const sent = await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
  const { id } = sent.result.structuredContent;
  const waited = await mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: 1 } });
  assert.equal(waited.result.structuredContent.status, "WAITING");
  assert.match(waited.result.content[0].text, /No answers yet/);
  assert.ok(fake.grill(id), "grill kept");
});

test("a cancelled grill_wait stops promptly and the server stays responsive", async (t) => {
  const { mcp } = await fixture(t);
  const sent = await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
  const { id } = sent.result.structuredContent;

  const waitId = mcp.nextId;
  const waited = mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: 300 } });
  await sleep(150);
  mcp.notify("notifications/cancelled", { requestId: waitId });

  // ping during (and after) the cancelled wait answers right away
  const pong = await mcp.request("ping");
  assert.deepEqual(pong.result, {});
  await Promise.race([waited, sleep(2000)]); // the cancelled call may answer late or never; it must not hang the server
  const cancelled = await mcp.request("tools/call", { name: "grill_cancel", arguments: { id } });
  assert.equal(cancelled.result.structuredContent.status, "CANCELLED");
});

test("ping answers while a grill_wait is still waiting", async (t) => {
  const { mcp } = await fixture(t);
  const sent = await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
  const { id } = sent.result.structuredContent;
  const waited = mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: 3 } });
  await sleep(150);
  const pong = await mcp.request("ping"); // answered before the wait's 3 s are up
  assert.deepEqual(pong.result, {});
  const done = await waited;
  assert.equal(done.result.structuredContent.status, "WAITING");
});

test("bad input is a tool error carrying the schema, and stdout stays clean JSON-RPC", async (t) => {
  const { mcp, child } = await fixture(t);
  const res = await mcp.request("tools/call", { name: "grill_send", arguments: { text: "no questions here" } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /no questions found/);
  assert.match(res.result.content[0].text, /Expected schema:/);

  const both = await mcp.request("tools/call", { name: "grill_send", arguments: {} });
  assert.equal(both.result.isError, true);
  assert.match(both.result.content[0].text, /exactly one of grill \/ text/);

  // stderr diagnostics never carry tool arguments or results
  child.kill();
  assert.doesNotMatch(mcp.stderr, /no questions here|Q1 -/);
});

test("the UA falls back through the allowlist for unknown clients", async (t) => {
  const { fake, mcp } = await fixture(t, { clientName: "Emacs MCP" });
  await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
  const creates = fake.requests().filter((x) => x.method === "POST" && x.path === "/api/g");
  assert.equal(creates.at(-1).userAgent, "grill-me-ai/0.1.0 (other)");
});
