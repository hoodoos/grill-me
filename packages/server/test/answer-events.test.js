import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../src/server.js";
import { publicAddress, callbackUrl, callbackPost, signingKey, safeEqual } from "../src/callback-transport.js";
import { parseSessionLink, deriveSessionKeys, sealRoundAnswers } from "../../core/src/session.js";
import { newId, newSecret } from "../../core/src/index.js";

const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const protocol = "2026-07-28", prefix = "io.modelcontextprotocol/";
const meta = { [prefix + "protocolVersion"]: protocol, [prefix + "clientCapabilities"]: {} };
const grill = { v: 1, questions: [{ n: 1, title: "Disposable event question", body: "PRIVATE_QUESTION_SENTINEL", recommend: { why: "Test" } }] };
const secret = "whsec_" + Buffer.alloc(32, 17).toString("base64");
const delivery = { mode: "webhook", url: "https://receiver.example/events/PRIVATE_CALLBACK_SENTINEL", secret };
const parse = text => JSON.parse(text.startsWith(":") ? text.split("\n").find(l => l.startsWith("data: ")).slice(6) : text);
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = performance.now() + 3000; while (!fn()) { assert.ok(performance.now() < end, "causal condition reached within3s"); await pause(5); } }
function signed(request) {
  const h = request.headers, body = request.body;
  const expected = crypto.createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${h["webhook-id"]}.${h["webhook-timestamp"]}.`).update(body).digest("base64");
  assert.ok(h["webhook-signature"].split(" ").includes("v1," + expected));
}
async function fixture(t, eventOptions = {}, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-events-")), db = path.join(dir, "relay.sqlite"), received = [], logs = [];
  let time = Date.now(), srv, base;
  const post = async (url, request) => {
    signed(request); const body = JSON.parse(request.body); received.push({ url, ...request, data: body });
    return body.type === "verification" ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) } : { status: 202, body: "" };
  };
  const launch = async () => {
    srv = createServer({ db, now: () => time, sweepMs: 100_000, log: s => logs.push(s), eventOptions: { post, tickMs: 10, ...eventOptions }, ...options });
    await new Promise(r => srv.server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${srv.server.address().port}`;
  };
  await launch(); const inspect = new DatabaseSync(db);
  t.after(async () => { srv.server.closeAllConnections(); await srv.close(); inspect.close(); await fs.rm(dir, { recursive: true, force: true }); });
  let sequence = 0;
  const rpc = async (method, params = {}, modern = true, extraHeaders = {}, fetchOptions = {}) => {
    const values = modern ? { ...params, _meta: { ...meta, ...params._meta } } : params;
    const r = await fetch(base + "/mcp", { method: "POST", headers: { ...headers, ...(modern ? { "mcp-protocol-version": protocol, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": params.name } : {}) } : {}), ...extraHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params: values }), ...fetchOptions });
    return { status: r.status, body: parse(await r.text()) };
  };
  const call = async (name, args = {}, modern = true) => (await rpc("tools/call", { name, arguments: args }, modern)).body.result;
  const start = async () => (await call("grill_start")).structuredContent;
  const send = async (link, round = 1, expectedRevision = 0) => (await call("grill_send", { link, round, expectedRevision, grill })).structuredContent;
  const subscribe = (link, extra = {}, method = "events/subscribe") => rpc(method, { name: "grill.answers_ready", arguments: { link }, delivery, ...extra });
  const blob = async (link, round = 1) => {
    const ids = parseSessionLink(link), keys = await deriveSessionKeys(ids.secret);
    return { ids, keys, body: { expectedRevision: 1 + (round - 1) * 3, submissionId: newId(), ...await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }] }, grill, { ...ids, round }) } };
  };
  const postAnswer = async (a, round = 1) => fetch(`${base}/api/s/${a.ids.id}/rounds/${round}/answers`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${a.keys.writeToken}` }, body: JSON.stringify(a.body),
  });
  return { dir, db, inspect, received, logs, rpc, call, start, send, subscribe, blob, postAnswer, advance: ms => { time += ms; }, now: () => time,
    restart: async () => { srv.server.closeAllConnections(); await srv.close(); await launch(); }, base: () => base };
}

test("actual modern HTTP envelopes/headers/discovery coexist with legacy initialization and sanitized failures", async t => {
  const f = await fixture(t);
  const discover = await f.rpc("server/discover"); assert.equal(discover.status, 200);
  for (const k of ["cacheScope", "capabilities", "resultType", "supportedVersions", "ttlMs"]) assert.ok(Object.hasOwn(discover.body.result, k));
  assert.equal(discover.body.result.resultType, "complete"); assert.ok(discover.body.result.capabilities.events);
  assert.equal(discover.body.result._meta[prefix + "serverInfo"].name, "grill-me-hosted");
  const tools = (await f.rpc("tools/list")).body.result;
  assert.equal(tools.cacheScope, "public"); assert.equal(tools.resultType, "complete"); assert.equal(tools.tools.length, 8);
  const init = await f.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } }, false);
  assert.equal(init.body.result.protocolVersion, "2025-11-25"); assert.equal(init.body.result.resultType, undefined);
  assert.equal((await f.rpc("ping", {}, false)).status, 200);
  assert.equal((await f.rpc("ping")).status, 404, "modern protocol removed legacy ping");
  assert.equal((await f.rpc("tools/list", {}, false)).body.result.tools.length, 8);
  for (const [params, h, code] of [
    [{}, { "mcp-method": "private_sentinel" }, -32020],
    [{ _meta: { [prefix + "clientCapabilities"]: null } }, {}, -32602],
    [{ _meta: { [prefix + "protocolVersion"]: "2027-01-01" } }, { "mcp-protocol-version": "2027-01-01" }, -32022],
  ]) { const r = await f.rpc("tools/list", params, true, h); assert.equal(r.status, 400); assert.equal(r.body.error.code, code); assert.ok(!JSON.stringify(r.body).includes("private_sentinel")); }
  const mismatch = await f.rpc("tools/call", { name: "grill_start" }, true, { "mcp-name": "wrong" }); assert.equal(mismatch.body.error.code, -32020);
  const draft = await f.rpc("tools/list", { _meta: { [prefix + "protocolVersion"]: "draft" } }, true, { "mcp-protocol-version": "draft" });
  assert.equal(draft.body.error.code, -32022); assert.equal(draft.body.error.data.requested, "draft"); assert.ok(draft.body.error.data.supported.includes(protocol));
  const encoded = await f.rpc("tools/call", { name: "grill_start" }, true, { "mcp-name": "=?base64?Z3JpbGxfc3RhcnQ=?=" }); assert.equal(encoded.body.result.structuredContent.status, "PREPARED");
  const unknown = await f.rpc("PRIVATE_UNKNOWN_METHOD"); assert.equal(unknown.status, 404); assert.equal(unknown.body.error.code, -32601); assert.ok(!JSON.stringify(unknown.body).includes("PRIVATE_UNKNOWN"));
});

test("answer CAS and durable outbox are atomic: six contenders, retries, rollback, callback2xx never ACK", async t => {
  const f = await fixture(t), cap = await f.start(); await f.subscribe(cap.link); await f.send(cap.link);
  const ids = parseSessionLink(cap.link);
  f.inspect.exec("CREATE TRIGGER fail_event BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(FAIL,'fault'); END;");
  const original = await f.blob(cap.link);
  assert.equal((await f.postAnswer(original)).status, 500);
  assert.equal(f.inspect.prepare("SELECT state FROM sessions WHERE id=?").get(ids.id).state, "pending");
  f.inspect.exec("DROP TRIGGER fail_event");
  const contenders = await Promise.all(Array.from({ length: 6 }, () => f.blob(cap.link)));
  const responses = await Promise.all(contenders.map(a => f.postAnswer(a))); assert.deepEqual(responses.map(r => r.status).sort(), [204,409,409,409,409,409]);
  const winner = contenders[responses.findIndex(r => r.status === 204)]; assert.equal((await f.postAnswer(winner)).status, 200);
  await until(() => f.received.some(r => r.data.name));
  assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM event_outbox").get().n, 1);
  const delivered = f.received.filter(r => r.data.name); assert.equal(delivered.length, 1); assert.equal(delivered[0].data.data.submissionId, winner.body.submissionId);
  assert.deepEqual(Object.keys(delivered[0].data.data).sort(), ["revision", "round", "sessionId", "submissionId"]);
  assert.equal(f.inspect.prepare("SELECT state FROM sessions WHERE id=?").get(ids.id).state, "answered", "callback202 cannot discard ciphertext");
  const answers = (await f.call("grill_wait", { link: cap.link, round: 1, seconds: 1 })).structuredContent;
  assert.equal(answers.answers, "Q1 - agree");
  await f.call("grill_ack", { link: cap.link, receipt: answers.receipt });
  assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM event_outbox").get().n, 0);
  await f.send(cap.link, 2, 3);
  await f.call("grill_ack", { link: cap.link, receipt: answers.receipt });
  assert.equal(f.inspect.prepare("SELECT state FROM sessions WHERE id=?").get(ids.id).state, "pending");
});

test("subscribe catch-up after answer and answer during challenge cannot miss current uncollected answers", async t => {
  let release, entered; const barrier = new Promise(r => { entered = r; });
  const f = await fixture(t, { post: async (_url, req) => {
    signed(req); const data = JSON.parse(req.body);
    if (data.type === "verification") { entered(); await new Promise(r => { release = r; }); return { status: 200, body: JSON.stringify({ challenge: data.challenge }) }; }
    return { status: 202, body: "" };
  } });
  const cap = await f.start(); await f.send(cap.link);
  const sub = f.subscribe(cap.link); await barrier;
  assert.equal((await f.postAnswer(await f.blob(cap.link))).status, 204);
  release(); assert.ok((await sub).body.result.id);
  await until(() => f.inspect.prepare("SELECT COUNT(*) n FROM event_outbox").get().n === 1);
  assert.equal(f.inspect.prepare("SELECT round FROM event_outbox").get().round, 1);
});

test("unsubscribe invalidates a challenge in flight and failed challenge never activates", async t => {
  let release, enter; const barrier = new Promise(r => { enter = r; });
  const f = await fixture(t, { post: async (_url, req) => { const body = JSON.parse(req.body); enter(); await new Promise(r => { release = r; }); return { status: 200, body: JSON.stringify({ challenge: body.challenge }) }; } });
  const cap = await f.start();
  const sub = f.subscribe(cap.link); await barrier;
  await f.subscribe(cap.link, {}, "events/unsubscribe"); release();
  assert.equal((await sub).body.error.data.reason, "conflict"); assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM event_subscriptions").get().n, 0);
  const broken = await fixture(t, { post: async () => ({ status: 202, body: "{}" }) });
  assert.equal((await broken.subscribe((await broken.start()).link)).body.error.data.reason, "challenge_failed");
  assert.equal(broken.inspect.prepare("SELECT COUNT(*) n FROM event_subscriptions").get().n, 0);
});

test("retry/restart preserve stable event body/id but fresh signing time; encrypted configuration stays private", async t => {
  let allow = false; const attempts = [];
  const f = await fixture(t, { post: async (url, req) => {
    signed(req); const body = JSON.parse(req.body);
    if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    attempts.push({ ...req, url }); return { status: allow ? 202 : 503, body: "" };
  } });
  const cap = await f.start(); await f.send(cap.link); await f.subscribe(cap.link);
  await f.postAnswer(await f.blob(cap.link)); await until(() => attempts.length === 1);
  const keyBefore = await fs.readFile(path.join(f.dir, "callback-sealing.key"));
  await f.restart(); assert.deepEqual(await fs.readFile(path.join(f.dir, "callback-sealing.key")), keyBefore);
  allow = true; f.advance(2000); await until(() => attempts.length === 2);
  assert.equal(attempts[0].body, attempts[1].body); assert.equal(attempts[0].headers["webhook-id"], attempts[1].headers["webhook-id"]);
  assert.notEqual(attempts[0].headers["webhook-timestamp"], attempts[1].headers["webhook-timestamp"]); assert.notEqual(attempts[0].headers["webhook-signature"], attempts[1].headers["webhook-signature"]);
  const stored = JSON.stringify(f.inspect.prepare("SELECT * FROM event_subscriptions").all());
  for (const value of [secret, delivery.url, parseSessionLink(cap.link).secret, "PRIVATE_QUESTION_SENTINEL"]) {
    assert.ok(!stored.includes(value)); assert.ok(!f.logs.join().includes(value));
    for (const file of [f.db, f.db + "-wal"]) { const bytes = await fs.readFile(file).catch(() => Buffer.alloc(0)); assert.ok(!bytes.includes(Buffer.from(value))); }
  }
  const mode = (await fs.stat(path.join(f.dir, "callback-sealing.key"))).mode & 0o777;
  if (process.platform !== "win32") assert.equal(mode, 0o600);
});

test("expiry/cancel/finish/unsubscribe prune bounded metadata; known missing sealing key refuses restart", async t => {
  const f = await fixture(t);
  for (const operation of ["cancel", "unsubscribe", "expiry", "finish"]) {
    const cap = await f.start(); await f.send(cap.link); await f.subscribe(cap.link);
    if (operation === "finish") {
      await f.postAnswer(await f.blob(cap.link)); const result = (await f.call("grill_wait", { link: cap.link, round: 1, seconds: 1 })).structuredContent;
      await f.call("grill_ack", { link: cap.link, receipt: result.receipt }); await f.call("grill_finish", { link: cap.link, expectedRevision: 3 });
    } else if (operation === "cancel") await f.call("grill_cancel", { link: cap.link });
    else if (operation === "unsubscribe") await f.subscribe(cap.link, {}, "events/unsubscribe");
    else { f.advance(3_600_001); await until(() => f.inspect.prepare("SELECT COUNT(*) n FROM event_subscriptions").get().n === 0); }
    assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM event_subscriptions").get().n, 0);
    assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM event_outbox").get().n, 0);
  }
  const cap = await f.start(); await f.subscribe(cap.link);
  await fs.rename(path.join(f.dir, "callback-sealing.key"), path.join(f.dir, "original-key"));
  assert.throws(() => createServer({ db: f.db }), /sealing key missing/);
});

test("Grok does NOT call verification/paid trigger; host checkpoint required before ACK and exact retry", async t => {
  const f = await fixture(t), cap = await f.start(); await f.send(cap.link);
  const subscribed = await f.call("grill_subscribe", { link: cap.link, url: delivery.url, secret, contextReference: "host-owned:tree" });
  assert.equal(subscribed.structuredContent.contextContinuity, "host_checkpoint_required_not_verified"); assert.equal(f.received.length, 0);
  await f.postAnswer(await f.blob(cap.link)); await until(() => f.received.length === 1);
  assert.equal(f.received[0].data.name, "grill.answers_ready");
  const received = (await f.call("grill_wait", { link: cap.link, round: 1, seconds: 1 })).structuredContent;
  assert.equal((await f.call("grill_ack", { link: cap.link, receipt: received.receipt })).isError, true);
  assert.equal(f.inspect.prepare("SELECT state FROM sessions").get().state, "answered");
  const contextReceipt = { reference: "host-owned:tree", revision: "after-round1" };
  assert.equal((await f.call("grill_ack", { link: cap.link, receipt: received.receipt, contextReceipt })).structuredContent.status, "ACKNOWLEDGED");
  assert.equal((await f.call("grill_ack", { link: cap.link, receipt: received.receipt, contextReceipt })).structuredContent.status, "ACKNOWLEDGED");
  assert.equal((await f.call("grill_ack", { link: cap.link, receipt: received.receipt, contextReceipt: { ...contextReceipt, revision: "wrong-retry" } })).isError, true);
});

test("callback address/secret boundary blocks private, mapped IPv6, mixed DNS, rebinding, credentials and redirect", async () => {
  for (const ip of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "169.254.169.254", "100.100.100.200", "172.20.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::1", "::ffff:7f00:1", "::ffff:a00:1", "2001:db8::1", "2002:7f00:1::", "fc00::1", "fe80::1", "64:ff9b::7f00:1"]) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(publicAddress(ip), true, ip);
  for (const url of ["http://example.com", "https://user:pw@example.com", "https://example.com:8443", "https://example.com/#key", "https://2130706433", "https://[::ffff:127.0.0.1]", "https://localhost"]) assert.throws(() => callbackUrl(url));
  for (const key of ["bad", "whsec_bad", "whsec_" + Buffer.alloc(23).toString("base64")]) assert.throws(() => signingKey(key));
  assert.equal(safeEqual("x", "xx"), false); assert.equal(safeEqual("secret", "secret"), true);
  let requests = 0;
  await assert.rejects(callbackPost("https://receiver.example", { body: "{}", headers: {} }, {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], request: () => { requests++; },
  }), e => e.reason === "blocked_address"); assert.equal(requests, 0);
  let resolves = 0;
  for (const _ of [1, 2]) await assert.rejects(callbackPost("https://receiver.example", { body: "{}", headers: {} }, {
    resolve: async () => { resolves++; return [{ address: "169.254.169.254", family: 4 }]; },
  }), e => e.reason === "blocked_address");
  assert.equal(resolves, 2, "resolve every connection; never use a stale validated DNS cache");
});

test("subscription refresh identity/key rotation/caps and bounded retry exhaustion/410/413", async t => {
  const attempts = [];
  let status = 503;
  const f = await fixture(t, { subscriptions: 1, post: async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    attempts.push(request); return { status, body: "" };
  } });
  const cap = await f.start(); await f.send(cap.link);
  const first = await f.subscribe(cap.link), repeat = await f.subscribe(cap.link);
  assert.equal(first.body.result.id, repeat.body.result.id);
  const other = await f.start(); assert.equal((await f.subscribe(other.link)).body.error.data.reason, "capacity");
  const rotatedSecret = "whsec_" + Buffer.alloc(32, 23).toString("base64");
  const rotated = await f.subscribe(cap.link, { delivery: { ...delivery, secret: rotatedSecret } }); assert.equal(rotated.body.result.id, first.body.result.id);
  await f.postAnswer(await f.blob(cap.link)); await until(() => attempts.length === 1);
  assert.equal(attempts[0].headers["webhook-signature"].split(" ").length, 2, "rotation grace signs old+new keys");
  for (let count = 2; count <= 8; count++) {
    await until(() => f.inspect.prepare("SELECT lease_until FROM event_outbox").get().lease_until === 0);
    f.advance(f.inspect.prepare("SELECT next_at FROM event_outbox").get().next_at - f.now() + 1);
    await until(() => attempts.length === count);
  }
  await until(() => f.inspect.prepare("SELECT state FROM event_outbox").get().state === "stopped");
  f.advance(1000); await pause(25); assert.equal(attempts.length, 8, "bounded retries");
  const receipt = (await f.call("grill_wait", { link: cap.link, round: 1, seconds: 1 })).structuredContent.receipt;
  await f.call("grill_ack", { link: cap.link, receipt });
  let rev = 3;
  for (const stopped of [410, 413]) {
    status = stopped; const round = stopped === 410 ? 2 : 3;
    await f.send(cap.link, round, rev); const before = attempts.length;
    await f.postAnswer(await f.blob(cap.link, round), round); await until(() => attempts.length === before + 1);
    await until(() => f.inspect.prepare("SELECT state FROM event_outbox").get().state === "stopped");
    const value = (await f.call("grill_wait", { link: cap.link, round, seconds: 1 })).structuredContent;
    rev = (await f.call("grill_ack", { link: cap.link, receipt: value.receipt })).structuredContent.revision;
  }
});

test("lease and subscription expiry during signed verification cannot activate or leak a callback", async t => {
  let release, enter; const barrier = new Promise(r => { enter = r; });
  const f = await fixture(t, { post: async (_url, request) => {
    const body = JSON.parse(request.body); enter(); await new Promise(r => { release = r; }); return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
  } });
  const cap = await f.start(), pending = f.subscribe(cap.link); await barrier;
  f.advance(600_001); release(); assert.ok((await pending).body.error);
  assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM event_subscriptions").get().n, 0);
});

test("wrong capabilities cannot consume the authenticated session registration budget", async t => {
  const f = await fixture(t), cap = await f.start(); await f.send(cap.link);
  for (let attempt = 0; attempt < 10; attempt++) {
    const wrong = cap.link.split("#")[0] + "#" + newSecret();
    assert.equal((await f.call("grill_subscribe", { link: wrong, url: delivery.url, secret, contextReference: "host-context" })).isError, true);
  }
  const valid = await f.call("grill_subscribe", { link: cap.link, url: delivery.url, secret, contextReference: "host-context" });
  assert.equal(valid.structuredContent.status, "SUBSCRIBED"); assert.equal(f.received.length, 0);
});

test("connection abort reclaims callback slot; a pending challenge cannot create an unbounded queue", async t => {
  let active = 0;
  const f = await fixture(t, { concurrent: 1, post: async (_url, request) => {
    active++;
    try { await new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("closed")), { once: true })); }
    finally { active--; }
  } });
  const cap = await f.start(), other = await f.start(), controller = new AbortController();
  const params = { name: "grill.answers_ready", arguments: { link: cap.link }, delivery };
  const request = f.rpc("events/subscribe", params, true, {}, { signal: controller.signal });
  const rejected = assert.rejects(request); await until(() => active === 1);
  assert.equal((await f.subscribe(other.link)).body.error.data.reason, "capacity");
  controller.abort(); await rejected; await until(() => active === 0);
  assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM event_subscriptions").get().n, 0);
});

test("receiver got event but lost reply/restart retries SAME metadata without ACK or duplicate logical event", async t => {
  const attempts = []; let loseReply = true;
  const f = await fixture(t, { post: async (_url, request) => {
    signed(request); const data = JSON.parse(request.body);
    if (data.type === "verification") return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    attempts.push(request);
    if (loseReply) await new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("reply lost")), { once: true }));
    return { status: 202, body: "" };
  } });
  const cap = await f.start(); await f.subscribe(cap.link); await f.send(cap.link); await f.postAnswer(await f.blob(cap.link));
  await until(() => attempts.length === 1); await f.restart();
  assert.equal(f.inspect.prepare("SELECT state FROM sessions").get().state, "answered");
  loseReply = false; f.advance(15_001); await until(() => attempts.length === 2);
  assert.equal(attempts[0].body, attempts[1].body); assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM event_outbox").get().n, 1);
  assert.equal(f.inspect.prepare("SELECT state FROM sessions").get().state, "answered");
});

test("a guessed-id preparation cannot reserve the real owner's subscription after first publish", async t => {
  const f = await fixture(t), cap = await f.start(), guessed = cap.link.split("#")[0] + "#" + newSecret();
  const impostor = await f.call("grill_subscribe", { link: guessed, url: delivery.url, secret, contextReference: "impostor-checkpoint" });
  assert.equal(impostor.structuredContent.status, "SUBSCRIBED");
  await f.send(cap.link);
  assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM event_subscriptions").get().n, 0);
  const owner = await f.subscribe(cap.link); assert.ok(owner.body.result.id);
});
