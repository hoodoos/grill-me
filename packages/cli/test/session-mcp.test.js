import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "../../server/src/server.js";
import { readPending } from "../src/pending.js";
import { deriveSessionKeys, sealRoundAnswers } from "../../core/src/session.js";
import { newId } from "../../core/src/crypto.js";

test("actual stdio: complete upstream instructions, same-id rounds and finish (HTTP-simulated phone)", { timeout: 30000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gm-session-stdio-"));
  const srv = createServer();
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  const server = `http://127.0.0.1:${srv.server.address().port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/grill-me.js", import.meta.url)), "mcp"], {
    env: { ...process.env, GRILL_ME_HOME: home, GRILL_ME_SERVER: server }, stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "", nextId = 0, stderr = "";
  const pending = new Map();
  child.stderr.on("data", b => stderr += b);
  child.stdout.on("data", b => {
    buffer += b;
    let n;
    while ((n = buffer.indexOf("\n")) !== -1) {
      const response = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      const waiter = pending.get(response.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(response.id); waiter.resolve(response); }
    }
  });
  t.after(async () => {
    child.kill();
    for (const p of pending.values()) clearTimeout(p.timer);
    await srv.close(); await fs.rm(home, { recursive: true, force: true });
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 6000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const r = await request("tools/call", { name, arguments: args });
    assert.ok(!r.result?.isError && !r.error, JSON.stringify(r));
    return r.result.structuredContent;
  };
  const skill = await fs.readFile(new URL("../../core/src/grilling.md", import.meta.url), "utf8");
  const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/, "");
  const init = await request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "Codex" } });
  assert.ok(init.result.instructions.includes(body));
  const tools = await request("tools/list");
  assert.deepEqual(tools.result.tools.map(t => t.name), ["grill_send", "grill_wait", "grill_cancel", "grill_finish"]);
  const text = /```\r?\n([\s\S]*?)```/.exec(skill)[1]; // the upstream example, byte-unchanged
  const first = await call("grill_send", { session: true, text });
  assert.equal(first.round, 1);
  assert.equal(Object.hasOwn(first, "qr"), false);
  assert.equal((await call("grill_wait", { id: first.id, seconds: 1 })).status, "WAITING");
  const answer = async id => {
    const r = await readPending(home, id), keys = await deriveSessionKeys(r.secret);
    const blob = await sealRoundAnswers({ v: 1, answers: r.grill.questions.map(q => ({ n: q.n, kind: "agree" })) }, r.grill, { id, secret: r.secret, round: r.round });
    const response = await fetch(`${server}/api/s/${id}/rounds/${r.round}/answers`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${keys.writeToken}` },
      body: JSON.stringify({ expectedRevision: r.revision, submissionId: newId(), ...blob }) });
    assert.equal(response.status, 204);
  };
  const idle = async id => {
    const until = performance.now() + 5000;
    while ((await readPending(home, id))?.state !== "idle") {
      assert.ok(performance.now() < until, "stdout reply must be followed by successful ACK cleanup");
      await new Promise(r => setTimeout(r, 10));
    }
  };
  await answer(first.id);
  // This is the successful multi-round transport workflow. Short-budget/cancellation paths
  // have separate real-socket tests; allow durable Windows fsync/lock work to complete here.
  const one = await call("grill_wait", { id: first.id, seconds: 15 });
  assert.equal(one.answers, "Q1 - agree\nQ2 - agree"); await idle(first.id);
  const second = await call("grill_send", { session: true, id: first.id, round: 2, text });
  assert.equal(second.link, first.link); assert.equal(second.round, 2);
  await answer(first.id);
  const two = await call("grill_wait", { id: first.id, seconds: 15 });
  assert.equal(two.round, 2); assert.equal(two.status, "ANSWERS"); await idle(first.id);
  assert.equal((await call("grill_finish", { id: first.id })).status, "FINISHED");
  assert.equal(await readPending(home, first.id), null);
  assert.equal((await fetch(`${server}/api/s/${first.id}`)).status, 404);
});
