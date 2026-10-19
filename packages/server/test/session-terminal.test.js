import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../src/server.js";
import { sendRound } from "../../cli/src/index.js";
import { readPending } from "../../cli/src/pending.js";
import { deriveSessionKeys, sealRoundAnswers } from "../../core/src/session.js";
import { newId } from "../../core/src/crypto.js";

const grill = { v: 1, questions: [{ n: 1, title: "Disposable", body: "Current-only", recommend: { why: "Test" } }] };
async function setup(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gm-terminal-"));
  const file = path.join(home, "relay.sqlite");
  let clock = Date.now();
  const srv = createServer({ db: file, now: () => clock, sweepMs: 600_000, ...options });
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  const db = new DatabaseSync(file);
  t.after(async () => { db.close(); await srv.close(); await fs.rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const opts = { home, server: base };
  const create = async () => {
    const sent = await sendRound(grill, opts), record = await readPending(home, sent.id);
    const keys = await deriveSessionKeys(record.secret);
    const headers = { "content-type": "application/json", authorization: `Bearer ${keys.writeToken}` };
    return { ...sent, record, headers };
  };
  const request = (s, suffix, body, method = "POST") => fetch(`${base}/api/s/${s.id}${suffix}`, { method, headers: s.headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const idle = async s => {
    const blob = await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }] }, grill, { id: s.id, secret: s.record.secret, round: 1 });
    const submissionId = newId();
    assert.equal((await request(s, "/rounds/1/answers", { expectedRevision: 1, submissionId, ...blob })).status, 204);
    assert.equal((await request(s, "/rounds/1/ack", { expectedRevision: 2, submissionId })).status, 204);
  };
  const gone = async (id, suffix = "") => {
    const r = await fetch(`${base}/api/s/${id}${suffix}`);
    assert.equal(r.status, 404);
    return r.json();
  };
  const hold = async (id, query) => {
    const registered = new Promise(resolve => {
      const listener = req => { if (req.url === `/api/s/${id}${query}`) { srv.server.off("request", listener); resolve(); } };
      srv.server.on("request", listener);
    });
    const response = fetch(`${base}/api/s/${id}${query}`);
    await registered; // the real handler has installed its waiter before the next mutation
    return { response };
  };
  return { home, file, db, srv, base, create, idle, request, gone, hold, time: () => clock, advance: ms => { clock += ms; } };
}

test("finish commits a minimal receipt, wakes both polls, survives reconnect/restart, then expires", async t => {
  const f = await setup(t), s = await f.create();
  await f.idle(s);
  const phone = await f.hold(s.id, "?after=3&wait=10");
  const agent = await f.hold(s.id, "/rounds/1/answers?wait=10");
  assert.equal((await f.request(s, "/finish", { expectedRevision: 3 })).status, 204);
  for (const p of [phone, agent]) {
    const r = await p.response; assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: "gone", reason: "finished" });
  }
  assert.deepEqual(await f.gone(s.id), { error: "gone", reason: "finished" });
  const receipt = f.db.prepare("SELECT * FROM session_terminals WHERE id=?").get(s.id);
  assert.deepEqual(Object.keys(receipt).sort(), ["expires_at", "id", "reason"]);
  assert.equal(receipt.expires_at, f.time() + 600_000);
  assert.equal(f.db.prepare("SELECT * FROM sessions WHERE id=?").get(s.id), undefined);
  const restart = createServer({ db: f.file, now: f.time, sweepMs: 600_000 });
  await new Promise(r => restart.server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${restart.server.address().port}/api/s/${s.id}`);
    assert.equal(r.status, 404); assert.equal((await r.json()).reason, "finished");
  } finally { await restart.close(); }
  f.advance(599_999);
  assert.equal((await f.gone(s.id)).reason, "finished");
  assert.equal(f.db.prepare("SELECT expires_at FROM session_terminals WHERE id=?").get(s.id).expires_at, receipt.expires_at, "reads do not refresh receipts");
  f.advance(1);
  assert.deepEqual(await f.gone(s.id), { error: "gone" });
});

test("pending finish409 never records finished; cancel and racing finish preserve exactly the winning reason", async t => {
  const f = await setup(t), pending = await f.create();
  assert.equal((await f.request(pending, "/finish", { expectedRevision: 1 })).status, 409);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM session_terminals").get().n, 0);
  assert.equal((await fetch(`${f.base}/api/s/${pending.id}`)).status, 200);
  const held = await f.hold(pending.id, "?after=1&wait=10");
  assert.equal((await f.request(pending, "", null, "DELETE")).status, 204);
  assert.equal((await (await held.response).json()).reason, "cancelled");
  assert.equal((await f.gone(pending.id)).reason, "cancelled");
  const s = await f.create(); await f.idle(s);
  const [finish, cancel] = await Promise.all([f.request(s, "/finish", { expectedRevision: 3 }), f.request(s, "", null, "DELETE")]);
  assert.deepEqual([finish.status, cancel.status].sort(), [204, 404]);
  const reason = finish.status === 204 ? "finished" : "cancelled";
  assert.equal((await f.gone(s.id)).reason, reason);
  assert.equal((await (finish.status === 404 ? finish : cancel).json()).reason, reason);
});

test("live expiry is reasoned before sweeper, on poll timeout, and via sweeper; markers prune and unknown stays generic", async t => {
  const f = await setup(t, { ttlMs: 1000 }), s = await f.create();
  const held = await f.hold(s.id, "?after=1&wait=0.03");
  f.advance(1001);
  assert.equal((await (await held.response).json()).reason, "expired");
  assert.equal((await f.gone(s.id)).reason, "expired");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
  const beforeSweep = await f.create(); f.advance(1001);
  assert.equal((await f.gone(beforeSweep.id)).reason, "expired");
  assert.deepEqual(await f.gone(newId()), { error: "gone" });
  const fast = await setup(t, { ttlMs: 1000, sweepMs: 15 }), swept = await fast.create();
  const polling = await fast.hold(swept.id, "?after=1&wait=10"); fast.advance(1001);
  assert.equal((await (await polling.response).json()).reason, "expired");
  fast.advance(600_001);
  const until = performance.now() + 3000;
  while (fast.db.prepare("SELECT COUNT(*) n FROM session_terminals").get().n) {
    assert.ok(performance.now() < until, "sweeper prunes expired receipts"); await new Promise(r => setTimeout(r, 10));
  }
  assert.deepEqual(await fast.gone(swept.id), { error: "gone" });
});

test("actual SQLite receipt failure rolls back deletion for finish/cancel/expiry instead of losing the end reason", async t => {
  const f = await setup(t, { ttlMs: 1000 });
  for (const reason of ["finished", "cancelled", "expired"]) {
    const s = await f.create(); if (reason === "finished") await f.idle(s);
    f.db.exec("CREATE TRIGGER terminal_fault BEFORE INSERT ON session_terminals BEGIN SELECT RAISE(ABORT,'fixture'); END");
    let failed;
    if (reason === "finished") failed = await f.request(s, "/finish", { expectedRevision: 3 });
    else if (reason === "cancelled") failed = await f.request(s, "", null, "DELETE");
    else { f.advance(1001); failed = await fetch(`${f.base}/api/s/${s.id}`); }
    assert.equal(failed.status, 500);
    assert.ok(f.db.prepare("SELECT id FROM sessions WHERE id=?").get(s.id), "deletion rolled back with receipt insertion");
    assert.equal(f.db.prepare("SELECT id FROM session_terminals WHERE id=?").get(s.id), undefined);
    f.db.exec("DROP TRIGGER terminal_fault");
    if (reason === "finished") assert.equal((await f.request(s, "/finish", { expectedRevision: 3 })).status, 204);
    else if (reason === "cancelled") assert.equal((await f.request(s, "", null, "DELETE")).status, 204);
    assert.equal((await f.gone(s.id)).reason, reason);
  }
});

test("receipts have a hard count bound; same-id replacement clears stale reasons without retaining round data", async t => {
  const f = await setup(t), s = await f.create(); await f.idle(s);
  const insert = f.db.prepare("INSERT INTO session_terminals VALUES (?,?,?)");
  f.db.exec("BEGIN");
  for (let n = 0; n < 10_000; n++) insert.run(String(n).padStart(16, "0"), "expired", f.time() + 600_000);
  f.db.exec("COMMIT");
  assert.equal((await f.request(s, "/finish", { expectedRevision: 3 })).status, 204);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM session_terminals").get().n, 10_000);
  assert.equal((await f.gone(s.id)).reason, "finished");
  const blob = await import("../../core/src/session.js").then(m => m.sealRound(grill, { id: s.id, secret: s.record.secret, round: 1 }));
  assert.equal((await fetch(`${f.base}/api/s`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: s.id, round: 1, operationId: newId(), ...blob }) })).status, 201);
  assert.equal(f.db.prepare("SELECT id FROM session_terminals WHERE id=?").get(s.id), undefined);
  assert.equal((await fetch(`${f.base}/api/s/${s.id}`)).status, 200);
  assert.deepEqual(f.db.prepare("PRAGMA table_info(session_terminals)").all().map(c => c.name), ["id", "reason", "expires_at"]);
});
