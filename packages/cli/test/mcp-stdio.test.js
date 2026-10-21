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
import { readPending } from "../src/pending.js";

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
          const call = this.pending.get(msg.id);
          clearTimeout(call.timer);
          call.resolve(msg);
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no response within 30 s`));
      }, 30_000);
      this.pending.set(id, { resolve, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
}

async function fixture(t, { clientName = "Claude Code", env = {} } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "grill-me-mcp-"));
  const fake = await startFakeServer();
  const child = spawn(process.execPath, [BIN, "mcp"], {
    env: { ...process.env, GRILL_ME_HOME: home, GRILL_ME_SERVER: fake.url, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const mcp = new McpClient(child);
  t.after(async () => {
    child.kill();
    for (const call of mcp.pending.values()) clearTimeout(call.timer);
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
  return { home, fake, child, mcp, init };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (condition, timeout = 2000) => {
  const end = Date.now() + timeout;
  while (!(await condition())) {
    assert.ok(Date.now() < end, "post-delivery cleanup finished promptly");
    await sleep(10);
  }
};

test("MCP-only clients receive Matt Pocock's complete upstream grilling workflow", async (t) => {
  const { init } = await fixture(t);
  const source = await fs.readFile(new URL("../../core/src/grilling.md", import.meta.url), "utf8");
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/, "");
  assert.ok(init.result.instructions.includes(body), "complete upstream body, including format and completion rule");
});

test("initialize → tools/list → grill_send → phone answers → grill_wait → ANSWERS", async (t) => {
  const { home, fake, mcp } = await fixture(t);

  const list = await mcp.request("tools/list");
  assert.deepEqual(list.result.tools.map((x) => x.name), ["grill_send", "grill_wait", "grill_cancel", "grill_finish"]);

  const sent = await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
  const { id, link, count, expiresAt } = sent.result.structuredContent;
  assert.match(id, /^[A-Za-z0-9_-]{16}$/);
  assert.match(link, new RegExp(`^${fake.url}/g/`));
  assert.equal(Object.hasOwn(sent.result.structuredContent, "qr"), false);
  assert.equal(count, 4);
  assert.equal(typeof expiresAt, "number");
  assert.ok(sent.result.content[0].text.includes(`Grill it on your phone\n${link}`));
  assert.doesNotMatch(sent.result.content[0].text, /[▀▄█]|```/, "no QR or fenced payload");

  // the metrics user-agent carries the mapped MCP client name
  const creates = fake.requests().filter((x) => x.method === "POST" && x.path === "/api/g");
  assert.equal(creates.at(-1).userAgent, "grill-me-ai/0.2.0 (claude-code)");

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
  await until(() => !fake.grill(id));
  assert.equal(fake.grill(id), undefined, "post-delivery cleanup deletes the grill");
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
  assert.equal(creates.at(-1).userAgent, "grill-me-ai/0.2.0 (other)");
});

test("GRILL_ME_WAIT_SECONDS caps the seconds argument", async (t) => {
  const { fake, mcp } = await fixture(t, { env: { GRILL_ME_WAIT_SECONDS: "2" } });
  const sent = await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
  const { id } = sent.result.structuredContent;
  const waited = await mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: 50 } });
  assert.equal(waited.result.structuredContent.status, "WAITING");
  const params = fake.waitParams(id);
  assert.ok(params.length > 0);
  assert.ok(Math.max(...params) <= 2, `every poll capped at the env value: ${params}`);
});

test("a non-numeric seconds falls back to the default instead of NaN", async (t) => {
  const { fake, mcp } = await fixture(t, { env: { GRILL_ME_WAIT_SECONDS: "2" } });
  const sent = await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
  const { id } = sent.result.structuredContent;
  const waited = await mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: "abc" } });
  assert.equal(waited.result.structuredContent.status, "WAITING");
  const params = fake.waitParams(id);
  assert.ok(params.length > 0);
  assert.ok(params.every((p) => Number.isFinite(p) && p <= 2), `'abc' became the default, not NaN: ${params}`);
});

test("the grill_wait description carries the real default and max", async (t) => {
  const { mcp } = await fixture(t, { env: { GRILL_ME_WAIT_SECONDS: "840" } });
  const list = await mcp.request("tools/list");
  const wait = list.result.tools.find((x) => x.name === "grill_wait");
  assert.match(wait.inputSchema.properties.seconds.description, /\(default 840, max 840\)/);
});

test("without GRILL_ME_WAIT_SECONDS the description keeps the built-in numbers", async (t) => {
  const { mcp } = await fixture(t);
  const list = await mcp.request("tools/list");
  const wait = list.result.tools.find((x) => x.name === "grill_wait");
  assert.match(wait.inputSchema.properties.seconds.description, /\(default 45, max 900\)/);
});

test("an env value above 900 clamps to the local cap", async (t) => {
  const { mcp } = await fixture(t, { env: { GRILL_ME_WAIT_SECONDS: "2000" } });
  const list = await mcp.request("tools/list");
  const wait = list.result.tools.find((x) => x.name === "grill_wait");
  assert.match(wait.inputSchema.properties.seconds.description, /\(default 900, max 900\)/);
});

for (const fault of ["503", "stalled headers", "stalled body"]) {
  test(`real stdio grill_wait deadline covers ${fault} and preserves pending`, { timeout: 12_000 }, async (t) => {
    const { home, fake, mcp } = await fixture(t, { env: { GRILL_ME_WAIT_SECONDS: "4" } });
    const sent = await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
    const { id } = sent.result.structuredContent;
    fake.intercept((req, res) => {
      if (!req.url.includes("/answers")) return false;
      if (fault === "503") res.writeHead(503).end();
      else if (fault === "stalled body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        res.write('{"ct":');
      }
      return true;
    });
    const started = performance.now();
    const waited = await mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: 4 } });
    const elapsed = performance.now() - started;
    assert.equal(waited.result.structuredContent.status, "WAITING");
    assert.ok(elapsed >= 3800 && elapsed < 5200, `${fault} took ${elapsed} ms for a 4000 ms budget`);
    assert.ok(await readPending(home, id), "pending remains recoverable");
    assert.ok(fake.grill(id), "server grill is untouched");
    fake.intercept(() => false);
    const pending = await readPending(home, id);
    await phoneAnswer(fake.url, id, pending.secret, [{ n: 1, kind: "agree" }]);
    const recovered = await mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: 4 } });
    assert.equal(recovered.result.structuredContent.status, "ANSWERS");
  });
}

for (const fault of ["stalled DELETE headers", "committed lost reply", "committed stalled body", "cancel after committed DELETE"]) {
  test(`real stdio delivers before ${fault}, keeps ping responsive and recovers ciphertext`, { timeout: 12_000 }, async (t) => {
    const { home, fake, mcp } = await fixture(t, { env: { GRILL_ME_WAIT_SECONDS: "2" } });
    const sent = await mcp.request("tools/call", { name: "grill_send", arguments: { text: DEMO_TEXT } });
    const { id } = sent.result.structuredContent;
    const pending = await readPending(home, id);
    await phoneAnswer(fake.url, id, pending.secret, [{ n: 1, kind: "own", text: "Recover after lost DELETE" }]);
    if (fault === "stalled DELETE headers") fake.intercept((req) => req.method === "DELETE");
    else fake.afterDelete((_req, res) => {
      if (fault === "committed stalled body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        res.write('{"unfinished":');
      }
      return true;
    });
    const waitId = mcp.nextId;
    const started = performance.now();
    const waited = await mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: 2 } });
    assert.equal(waited.result.structuredContent.status, "ANSWERS");
    assert.ok(performance.now() - started < 1000, "MCP answer response does not wait for DELETE");
    await until(() => fake.requests().some((r) => r.method === "DELETE"));
    const pingStarted = performance.now();
    assert.deepEqual((await mcp.request("ping")).result, {});
    assert.ok(performance.now() - pingStarted < 750, "cleanup cannot block ping");
    if (fault === "cancel after committed DELETE") {
      mcp.notify("notifications/cancelled", { requestId: waitId });
      await until(() => mcp.stderr.includes("answer cleanup interrupted"));
      assert.ok(performance.now() - started < 1000, "the original controller survives reply and cancels cleanup promptly");
    } else await until(() => mcp.stderr.includes("answer cleanup interrupted"), 3000);
    const cached = await readPending(home, id);
    assert.ok(cached.answerBlob.ct);
    assert.ok(!JSON.stringify(cached).includes("Recover after lost DELETE"));
    if (fault !== "stalled DELETE headers") assert.equal(fake.grill(id), undefined, "server already committed DELETE");
    fake.intercept(() => false);
    fake.afterDelete(() => false);
    const before = fake.requests().length;
    const recovered = await mcp.request("tools/call", { name: "grill_wait", arguments: { id, seconds: 2 } });
    assert.match(recovered.result.structuredContent.answers, /Recover after lost DELETE/);
    await until(async () => (await readPending(home, id)) === null);
    assert.ok(fake.requests().slice(before).every((r) => r.method === "DELETE"), "replay needs no GET, and confirmed 404 can clear pending");
  });
}

test('configured wait limit is visible before waiting; short timeout supplies the same resume command and keeps identity', async t => {
  const { mcp } = await fixture(t, { env: { GRILL_ME_WAIT_SECONDS: '840' } });
  const init = await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Codex', version: '1' } });
  assert.match(init.result.instructions, /14 minutes per call/);
  assert.match(init.result.instructions, /Resume Grill Me/);
  const sent = await mcp.request('tools/call', { name: 'grill_send', arguments: { text: DEMO_TEXT } });
  assert.equal(sent.result.structuredContent.waitSeconds, 840);
  assert.equal(sent.result.structuredContent.maxWaitSeconds, 840);
  assert.match(sent.result.content[0].text, /14 minutes per call/);
  const id = sent.result.structuredContent.id;
  const waiting = await mcp.request('tools/call', { name: 'grill_wait', arguments: { id, seconds: 1 } });
  assert.equal(waiting.result.structuredContent.status, 'WAITING');
  assert.equal(waiting.result.structuredContent.waitSeconds, 1);
  assert.match(waiting.result.content[0].text, /1 second per call/);
  assert.match(waiting.result.content[0].text, /does not expire/);
  assert.match(waiting.result.content[0].text, /Resume Grill Me/);
  const cancelled = await mcp.request('tools/call', { name: 'grill_cancel', arguments: { id } });
  assert.equal(cancelled.result.structuredContent.status, 'CANCELLED');
});
