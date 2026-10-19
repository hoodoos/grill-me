import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../src/server.js";
import { HOSTED_INSTRUCTIONS } from "../src/hosted-mcp.js";
import { parseSessionLink, deriveSessionKeys, openRound, sealRoundAnswers } from "../../core/src/session.js";
import { newId } from "../../core/src/index.js";

const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const grill = { v: 1, questions: [{ n: 1, title: "Disposable hosted question", body: "Only this current round", recommend: { why: "A test recommendation" } }] };
const parse = raw => raw.startsWith(":") || raw.startsWith("event:")
  ? JSON.parse(raw.split("\n").find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(raw);
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-hosted-")), db = path.join(dir, "relay.sqlite"), logs = [];
  const srv = createServer({ db, statsToken: "x".repeat(40), log: text => logs.push(text), ...options });
  const inspect = new DatabaseSync(db);
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  t.after(async () => { srv.server.closeAllConnections(); await srv.close(); inspect.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  let seq = 0;
  const rpc = (method, params = {}, extra = {}) => fetch(base + "/mcp", { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }), ...extra });
  const call = async (name, args = {}, meta) => {
    const r = await rpc("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    assert.equal(r.status, 200); return parse(await r.text()).result;
  };
  const start = async () => (await call("grill_start")).structuredContent;
  const send = (link, round = 1, expectedRevision = 0, meta) => call("grill_send", { link, round, expectedRevision, grill }, meta);
  const answer = async (link, round, expectedRevision) => {
    const ids = parseSessionLink(link), keys = await deriveSessionKeys(ids.secret), submissionId = newId();
    const encrypted = await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }] }, grill, { ...ids, round });
    const r = await fetch(`${base}/api/s/${ids.id}/rounds/${round}/answers`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${keys.writeToken}` },
      body: JSON.stringify({ expectedRevision, submissionId, ...encrypted }) });
    assert.equal(r.status, 204); return submissionId;
  };
  const stats = async () => (await fetch(base + "/stats/data.json", { headers: { authorization: `Bearer ${"x".repeat(40)}` } })).json();
  return { base, rpc, call, start, send, answer, inspect, logs, dir, stats };
}

test("hosted instructions, six independent schemas and strict sanitized HTTP/JSON-RPC", async t => {
  const f = await fixture(t), sentinel = "DO_NOT_ECHO_PRIVATE_SENTINEL";
  const init = await (await f.rpc("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" }, capabilities: {} })).json();
  assert.equal(init.result.protocolVersion, "2025-11-25"); assert.equal(init.result.serverInfo.version, "0.2.0");
  assert.equal(init.result.instructions, HOSTED_INSTRUCTIONS);
  for (const word of ["grill_start", "grill_wait", "grill_ack", "receiving"]) assert.ok(init.result.instructions.slice(0, 512).includes(word));
  assert.ok(init.result.instructions.includes(await fs.readFile(new URL("../../core/src/grilling.md", import.meta.url), "utf8")));
  const tools = (await (await f.rpc("tools/list")).json()).result.tools;
  assert.deepEqual(tools.map(t => t.name), ["grill_start", "grill_send", "grill_wait", "grill_ack", "grill_finish", "grill_cancel"]);
  assert.equal(tools.find(t => t.name === "grill_wait").annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === "grill_ack").annotations.destructiveHint, true);
  for (const method of [sentinel, "tools/call"]) {
    const raw = await (await f.rpc(method, { name: sentinel, arguments: { link: sentinel } })).text();
    assert.ok(!raw.includes(sentinel));
  }
  for (const [override, status] of [[{ method: "GET", body: undefined }, 405], [{ headers: { ...headers, origin: "https://evil.example" } }, 403],
    [{ headers: { ...headers, accept: "application/json" } }, 406], [{ headers: { ...headers, "content-type": "text/plain" } }, 415],
    [{ headers: { ...headers, "mcp-session-id": "fake" } }, 400], [{ headers: { ...headers, "mcp-protocol-version": "bad" } }, 400],
    [{ body: "{" }, 400], [{ body: JSON.stringify([]) }, 400], [{ body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }) }, 400],
    [{ body: " ".repeat(32769) }, 413]]) assert.equal((await f.rpc("ping", {}, override)).status, status);
  assert.equal((await fetch(f.base + "/mcp?secret=" + sentinel, { method: "POST", headers, body: "{}" })).status, 400);
  assert.equal((await f.rpc("notifications/initialized", {}, { body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status, 202);
  assert.ok(f.logs.every(l => !l.includes(sentinel) && !l.includes("secret=")));
});

test("same-link two rounds, concurrent identical publish recovery, retained answers and exact explicit ACK", async t => {
  const f = await fixture(t, { createsPerHour: 0, waitersPerIp: 0 }), prepared = await f.start();
  const ids = parseSessionLink(prepared.link), keys = await deriveSessionKeys(ids.secret);
  assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0, "prepare writes nothing");
  const sent = await Promise.all(Array.from({ length: 6 }, () => f.send(prepared.link)));
  for (const r of sent) { assert.equal(r.isError, undefined, JSON.stringify(r)); assert.equal(r.structuredContent.status, "READY"); }
  assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
  assert.equal((await f.stats()).live.hosted.creates, 1);
  const row = f.inspect.prepare("SELECT * FROM sessions WHERE id=?").get(ids.id);
  assert.equal((await openRound(row, { ...ids, round: 1 })).questions[0].title, grill.questions[0].title);
  const conflict = await f.call("grill_send", { link: prepared.link, round: 1, expectedRevision: 0,
    grill: { ...grill, questions: [{ ...grill.questions[0], title: "Different" }] } }); assert.equal(conflict.isError, true);
  await f.answer(prepared.link, 1, 1);
  const received = (await f.call("grill_wait", { link: prepared.link, round: 1, seconds: 1 })).structuredContent;
  assert.equal(received.status, "ANSWERS"); assert.equal(received.answers, "Q1 - agree");
  assert.ok(f.inspect.prepare("SELECT ans_ct FROM sessions WHERE id=?").get(ids.id).ans_ct, "answer delivery does NOT ACK");
  const replay = (await f.call("grill_wait", { link: prepared.link, round: 1, seconds: 1 })).structuredContent;
  assert.deepEqual(replay, received, "lost output/restarted stateless call replays same answers/receipt");
  assert.equal((await f.call("grill_finish", { link: prepared.link, expectedRevision: 2 })).isError, true);
  const ack = () => f.call("grill_ack", { link: prepared.link, receipt: received.receipt });
  assert.equal((await ack()).structuredContent.status, "ACKNOWLEDGED");
  assert.equal((await ack()).structuredContent.revision, 3, "lost ACK reply retries exact original receipt");
  const cleared = f.inspect.prepare("SELECT * FROM sessions WHERE id=?").get(ids.id);
  assert.equal(cleared.ct, null); assert.equal(cleared.ans_ct, null); assert.equal(cleared.state, "idle");
  assert.equal((await f.call("grill_ack", { link: prepared.link, receipt: { ...received.receipt, expectedRevision: 3 } })).isError, true);
  assert.equal((await f.send(prepared.link)).structuredContent.status, "IDLE", "original publish retry after ACK remains exact saved operation");
  assert.equal((await f.send(prepared.link, 2, 3)).structuredContent.link, prepared.link);
  await ack(); assert.equal(f.inspect.prepare("SELECT state FROM sessions WHERE id=?").get(ids.id).state, "pending", "late oldACK cannot touch round2");
  await f.answer(prepared.link, 2, 4);
  const second = (await f.call("grill_wait", { link: prepared.link, round: 2, seconds: 1 })).structuredContent;
  assert.equal(second.answers, "Q1 - agree");
  assert.equal((await f.call("grill_ack", { link: prepared.link, receipt: second.receipt })).structuredContent.revision, 6);
  assert.equal((await f.call("grill_finish", { link: prepared.link, expectedRevision: 6 })).structuredContent.status, "FINISHED");
  assert.equal((await f.call("grill_finish", { link: prepared.link, expectedRevision: 6 })).structuredContent.reason, "finished");
  assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
  assert.ok(f.logs.every(l => !l.includes(ids.secret) && !l.includes(keys.writeToken) && !l.includes(grill.questions[0].title)));
  assert.equal(f.logs.filter(l => l.includes("/api/s/")).length, 2, "only actual phone answerHTTP requests are logged, not in-process hosted operations");
});

test("SSE headers precede waiting, default bounds/clamp schema, cancellation frees both capacities, local limits stay distinct", async t => {
  const f = await fixture(t, { waitersPerIp: 0, hostedLimits: { waits: 1 } }), s = await f.start(); await f.send(s.link);
  const controller = new AbortController(), started = performance.now();
  t.after(() => controller.abort());
  const r = await f.rpc("tools/call", { name: "grill_wait", arguments: { link: s.link, round: 1, seconds: 2 } }, { signal: controller.signal });
  assert.equal(r.headers.get("content-type"), "text/event-stream"); assert.equal(r.headers.get("mcp-session-id"), null);
  assert.ok(performance.now() - started < 1000, "headers opened without waiting for answers");
  const admitted = performance.now() + 1000;
  while (!(await f.stats()).live.hosted.waits) { assert.ok(performance.now() < admitted); await new Promise(r => setTimeout(r, 5)); }
  const limited = await f.call("grill_wait", { link: s.link, round: 1, seconds: 1 }); assert.equal(limited.isError, true);
  controller.abort(); await r.body.cancel().catch(() => {});
  const until = performance.now() + 2000;
  while ((await f.stats()).live.hosted.waits) { assert.ok(performance.now() < until); await new Promise(r => setTimeout(r, 10)); }
  assert.equal((await f.stats()).live.waiters, 0);
  const before = performance.now(), waiting = await f.call("grill_wait", { link: s.link, round: 1, seconds: 1 });
  assert.equal(waiting.structuredContent.status, "WAITING"); assert.ok(performance.now() - before >= 900 && performance.now() - before < 2000);
  assert.equal((await f.call("grill_wait", { link: s.link, round: 1, seconds: 51 })).isError, true);
});

test("hosted global/conversation quotas are bounded and shared-platform IP cannot exhaust local quotas", async t => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock, createsPerHour: 0, hostedLimits: { creates: 3, conversation: 1 } });
  const a = await f.start(), b = await f.start(), c = await f.start(), d = await f.start();
  assert.equal((await f.send(a.link, 1, 0, { "openai/session": "private-conversation" })).isError, undefined);
  assert.equal((await f.send(b.link, 1, 0, { "openai/session": "private-conversation" })).isError, true);
  assert.equal((await f.send(b.link, 1, 0, { "openai/session": "other-conversation" })).isError, undefined);
  assert.equal((await f.send(c.link)).isError, undefined); assert.equal((await f.send(d.link)).isError, true);
  assert.equal((await f.stats()).live.hosted.createHeadroom, 0);
  clock += 3_600_001; assert.equal((await f.send(d.link)).isError, undefined);
  assert.ok(!JSON.stringify(f.inspect.prepare("SELECT * FROM stats").all()).includes("private-conversation"));
  assert.ok((await f.stats()).live.hosted.conversations <= 3);
});

test("capabilities never fetch model hosts, wrong keys/replay sanitized, no key/plaintext persisted", async t => {
  const f = await fixture(t), s = await f.start(), ids = parseSessionLink(s.link);
  for (const link of [s.link.replace("https://grill-me.ai", "http://127.0.0.1:1"), s.link.replace("?session=2", "?session=2&url=evil"),
    s.link.replace("https://", "https://user:password@"), s.link + "extra", "DO_NOT_ECHO_CAPABILITY"]) {
    const r = await f.send(link); assert.equal(r.isError, true); assert.ok(!JSON.stringify(r).includes(link));
  }
  await f.send(s.link);
  const wrong = s.link.slice(0, -22) + (await f.start()).link.slice(-22);
  assert.equal((await f.call("grill_wait", { link: wrong, round: 1, seconds: 1 })).isError, true);
  const blob = await fs.readFile(path.join(f.dir, "relay.sqlite"));
  assert.ok(!blob.includes(Buffer.from(ids.secret))); assert.ok(!blob.includes(Buffer.from(grill.questions[0].title)));
  assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
  assert.equal((await f.call("grill_cancel", { link: s.link })).structuredContent.status, "CANCELLED");
  assert.equal((await f.call("grill_wait", { link: s.link, round: 1, seconds: 1 })).structuredContent.reason, "cancelled");
});
