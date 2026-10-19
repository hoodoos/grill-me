import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "../../server/src/server.js";
import { sendRound, wait, finish } from "../src/index.js";
import { readPending } from "../src/pending.js";
import { writeOutput } from "../src/output.js";
import { deriveSessionKeys, sealRoundAnswers } from "../../core/src/session.js";
import { newId } from "../../core/src/crypto.js";

const grill = { v: 1, questions: [{ n: 1, title: "Disposable", body: "Same questions each round", recommend: { why: "Test" } }] };
async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "grill-session-client-"));
  const srv = createServer();
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  t.after(async () => { await srv.close(); await fs.rm(home, { recursive: true, force: true }); });
  return { home, server: `http://127.0.0.1:${srv.server.address().port}` };
}
async function answer(id, opts) {
  const record = await readPending(opts.home, id);
  const { writeToken } = await deriveSessionKeys(record.secret);
  const blob = await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }] }, grill, { id, secret: record.secret, round: record.round });
  const r = await fetch(`${opts.server}/api/s/${id}/rounds/${record.round}/answers`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` },
    body: JSON.stringify({ expectedRevision: record.revision, submissionId: newId(), ...blob }),
  });
  assert.equal(r.status, 204);
}
const snapshot = async (id, opts) => (await fetch(`${opts.server}/api/s/${id}`)).json();

test("two rounds reuse id/key/link; idle finish removes only the completed session", async t => {
  const opts = await setup(t), one = await sendRound(grill, opts);
  await assert.rejects(finish(one.id, opts), { code: "pending-round" });
  await answer(one.id, opts);
  await assert.rejects(sendRound(grill, { ...opts, id: one.id, round: 2 }), { code: "uncollected" });
  const result = await wait(one.id, { ...opts, seconds: 1 });
  assert.equal(result.lines, "Q1 - agree");
  assert.equal((await snapshot(one.id, opts)).state, "answered");
  await result.ack();
  const idle = await readPending(opts.home, one.id);
  assert.equal(idle.grill, null);
  assert.equal(idle.pendingAck, null);
  const two = await sendRound(grill, { ...opts, id: one.id, round: 2 });
  assert.equal(two.link, one.link);
  assert.equal(two.round, 2);
  await answer(one.id, opts);
  const second = await wait(one.id, { ...opts, seconds: 1 });
  await second.ack();
  assert.equal((await finish(one.id, opts)).status, "FINISHED");
  assert.equal(await readPending(opts.home, one.id), null);
  assert.equal((await fetch(`${opts.server}/api/s/${one.id}`)).status, 404);
});

test("failed stdout retains cache without ACK; next call replays before successful delivery", async t => {
  const opts = await setup(t), one = await sendRound(grill, opts);
  await answer(one.id, opts);
  const result = await wait(one.id, { ...opts, seconds: 1 });
  const broken = new Writable({ write(_b, _e, cb) { cb(new Error("closed output")); } });
  await assert.rejects(writeOutput(broken, result.lines, result.deliverySignal), /closed output/);
  result.dispose();
  assert.equal((await snapshot(one.id, opts)).state, "answered");
  assert.ok((await readPending(opts.home, one.id)).pendingAck);
  await assert.rejects(sendRound(grill, { ...opts, id: one.id, round: 2 }), { code: "unconfirmed" });
  const replay = await wait(one.id, { ...opts, seconds: 1 });
  assert.equal(replay.lines, result.lines);
  await replay.ack();
  assert.equal((await snapshot(one.id, opts)).state, "idle");
});

test("committed/lost ACK replies retain exact request; next send recovers and advances", async t => {
  const opts = await setup(t), one = await sendRound(grill, opts);
  await answer(one.id, opts);
  const result = await wait(one.id, { ...opts, seconds: 5 });
  const actualFetch = globalThis.fetch, bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/ack")) {
      bodies.push(options.body);
      await actualFetch(url, options);
      throw new Error("reply lost after commit");
    }
    return actualFetch(url, options);
  };
  try { await assert.rejects(result.ack(), { code: "unconfirmed" }); }
  finally { globalThis.fetch = actualFetch; }
  assert.ok(bodies.length > 1);
  assert.equal(new Set(bodies).size, 1);
  assert.equal((await snapshot(one.id, opts)).state, "idle");
  assert.equal((await readPending(opts.home, one.id)).pendingAck.delivered, true);
  const two = await sendRound(grill, { ...opts, id: one.id, round: 2 });
  assert.equal(two.link, one.link);
  assert.equal(two.round, 2);
});

test("late old delivery cannot clear a newer round record", async t => {
  const opts = await setup(t), one = await sendRound(grill, opts);
  await answer(one.id, opts);
  const old = await wait(one.id, { ...opts, seconds: 5 });
  const first = await wait(one.id, { ...opts, seconds: 5 });
  await first.ack();
  await sendRound(grill, { ...opts, id: one.id, round: 2 });
  const before = await readPending(opts.home, one.id);
  await assert.rejects(old.ack(), { code: "conflict" });
  assert.deepEqual(await readPending(opts.home, one.id), before);
  assert.equal((await snapshot(one.id, opts)).round, 2);
});

test("lost create replies expose one recoverable identity and resume the same intent", async t => {
  const opts = await setup(t), actualFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/api/s") && options?.method === "POST") {
      await actualFetch(url, options);
      throw new Error("create committed but reply lost");
    }
    return actualFetch(url, options);
  };
  try { sent = await sendRound(grill, { ...opts, attempts: 1 }); }
  finally { globalThis.fetch = actualFetch; }
  assert.equal(sent.status, "PUBLISHING");
  const before = await readPending(opts.home, sent.id);
  await assert.rejects(sendRound({ ...grill, title: "Different" }, { ...opts, id: sent.id, round: 1 }), { code: "conflict" });
  const resumed = await sendRound(grill, { ...opts, id: sent.id, round: 1 });
  assert.equal(resumed.link, sent.link);
  assert.equal(resumed.revision, 1);
  const snap = await snapshot(sent.id, opts);
  assert.equal(snap.operationId, before.publication.operationId);
  assert.equal(snap.ct, before.publication.ct);
});

test("delayed network collection cannot cache or deliver into a newer local round", async t => {
  const opts = await setup(t), one = await sendRound(grill, opts);
  await answer(one.id, opts);
  const actualFetch = globalThis.fetch;
  let release, captured;
  const received = new Promise(r => captured = r), held = new Promise(r => release = r);
  let intercepted = false;
  globalThis.fetch = async (url, options) => {
    const response = await actualFetch(url, options);
    if (!intercepted && String(url).includes("/rounds/1/answers?")) {
      intercepted = true; captured(); await held;
    }
    return response;
  };
  try {
    const delayed = wait(one.id, { ...opts, seconds: 5 });
    await received;
    const winner = await wait(one.id, { ...opts, seconds: 5 });
    await winner.ack();
    await sendRound(grill, { ...opts, id: one.id, round: 2 });
    const before = await readPending(opts.home, one.id);
    release();
    assert.equal((await delayed).status, "CONFLICT");
    assert.deepEqual(await readPending(opts.home, one.id), before);
  } finally { release(); globalThis.fetch = actualFetch; }
});

test("an independent process's late ACK cannot unlink the newer round", { timeout: 8000 }, async t => {
  const opts = await setup(t), one = await sendRound(grill, opts);
  await answer(one.id, opts);
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const code = `import {wait} from ${JSON.stringify(moduleUrl)};
    const result=await wait(${JSON.stringify(one.id)},${JSON.stringify({ ...opts, seconds: 5 })});
    process.stdout.write('READY\\n');
    process.stdin.once('data',async()=>{let code='ACK';try{await result.ack()}catch(e){code=e.code}
      process.stdout.write(code+'\\n',()=>process.exit(0));});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let output = "", ready, done, failed;
  const started = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const completed = new Promise(resolve => { done = resolve; });
  child.stdout.on("data", b => { output += b; if (output.includes("READY\n")) ready(); });
  child.on("error", failed);
  child.on("exit", code => { if (!output.includes("READY\n")) failed(new Error(`child ${code} before READY`)); done(code); });
  await started;
  const first = await wait(one.id, { ...opts, seconds: 2 });
  await first.ack();
  await sendRound(grill, { ...opts, id: one.id, round: 2 });
  const before = await readPending(opts.home, one.id);
  child.stdin.write("ack\n");
  assert.equal(await completed, 0);
  assert.match(output, /READY\nconflict\n/);
  assert.deepEqual(await readPending(opts.home, one.id), before);
});

test("a committed ACK with stalled response body respects the original deadline and replays", { timeout: 5000 }, async t => {
  const direct = await setup(t);
  let stalled = true, gets = 0;
  const proxy = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    if (req.method === "GET") gets++;
    const response = await fetch(direct.server + req.url, { method: req.method,
      headers: { "content-type": "application/json", ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
      ...(body ? { body } : {}) });
    const text = await response.text();
    if (stalled && req.url.endsWith("/ack")) { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); return; }
    res.writeHead(response.status, { "content-type": "application/json" }); res.end(text);
  });
  await new Promise(r => proxy.listen(0, "127.0.0.1", r));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); });
  const opts = { home: direct.home, server: `http://127.0.0.1:${proxy.address().port}` };
  const one = await sendRound(grill, opts); await answer(one.id, opts);
  const start = performance.now(), result = await wait(one.id, { ...opts, seconds: 1 });
  await assert.rejects(result.ack());
  assert.ok(performance.now() - start < 1600);
  assert.ok((await readPending(opts.home, one.id)).pendingAck);
  assert.equal((await snapshot(one.id, direct)).state, "idle");
  const before = gets;
  stalled = false;
  const replay = await wait(one.id, { ...opts, seconds: 1 });
  assert.equal(replay.lines, result.lines);
  assert.equal(gets, before, "cached ciphertext must be replayed before GET, even after server erasure");
  await replay.ack();
  assert.equal((await readPending(opts.home, one.id)).pendingAck, null);
});

test("cancellation after collection leaves encrypted cache and does not ACK", async t => {
  const opts = await setup(t), one = await sendRound(grill, opts), controller = new AbortController();
  await answer(one.id, opts);
  const result = await wait(one.id, { ...opts, seconds: 2, signal: controller.signal });
  controller.abort();
  await assert.rejects(result.ack(), { code: "aborted" });
  assert.ok((await readPending(opts.home, one.id)).pendingAck);
  assert.equal((await snapshot(one.id, opts)).state, "answered");
});
