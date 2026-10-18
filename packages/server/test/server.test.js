import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import {
  convert, DEMO_TEXT, newId, newSecret, sealGrill, openGrill, sealAnswers, openAnswers,
  answerLines, deriveKeys, b64urlEncode,
} from "../../core/src/index.js";

async function start(opts = {}) {
  const logs = [];
  const { server, close } = createServer({
    db: opts.db ?? ":memory:",
    log: (l) => logs.push(l),
    now: opts.now,
    ttlMs: opts.ttlMs,
    sweepMs: opts.sweepMs,
    maxWaitS: opts.maxWaitS,
    createsPerHour: opts.createsPerHour,
    waitersPerGrill: opts.waitersPerGrill,
    waitersPerIp: opts.waitersPerIp,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close, logs };
}

const demoGrill = () => convert(DEMO_TEXT).grill;

// Creates a real grill through core; returns { id, secret, grill }.
async function createGrill(base, extra = {}) {
  const grill = demoGrill();
  const id = newId(), secret = newSecret();
  const sealed = await sealGrill(grill, { id, secret });
  const r = await fetch(`${base}/api/g`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extra.headers },
    body: JSON.stringify({ id, ...sealed }),
  });
  return { id, secret, grill, sealed, res: r };
}

const b64 = (n) => b64urlEncode(new Uint8Array(n)); // n zero bytes, canonical base64url

test("create → 201 {id, expiresAt}; get → 200 {ct, iv, answered, expiresAt}", async () => {
  const { base, close } = await start();
  const { id, res, sealed } = await createGrill(base);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.id, id);
  assert.equal(typeof body.expiresAt, "number");
  const g = await fetch(`${base}/api/g/${id}`);
  assert.equal(g.status, 200);
  const got = await g.json();
  assert.equal(got.ct, sealed.ct);
  assert.equal(got.iv, sealed.iv);
  assert.equal(got.answered, false);
  assert.equal(got.expiresAt, body.expiresAt);
  await close();
});

test("creating with a taken id → 409", async () => {
  const { base, close } = await start();
  const first = await createGrill(base);
  const second = await createGrill(base);
  const r = await fetch(`${base}/api/g`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: first.id, ct: second.sealed.ct, iv: second.sealed.iv, writeHash: second.sealed.writeHash }),
  });
  assert.equal(r.status, 409);
  await close();
});

test("bad JSON and bad fields → 400 {error}", async () => {
  const { base, close } = await start();
  const post = (body) => fetch(`${base}/api/g`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post(JSON.stringify({ id: "short", ct: b64(20), iv: b64(12), writeHash: b64(32) }))).status, 400);
  assert.equal((await post(JSON.stringify({ id: newId(), ct: b64(20), iv: b64(11), writeHash: b64(32) }))).status, 400);
  assert.equal((await post(JSON.stringify({ id: newId(), ct: b64(20), iv: b64(12), writeHash: b64(31) }))).status, 400);
  assert.equal((await post(JSON.stringify({ id: newId(), ct: b64(16), iv: b64(12), writeHash: b64(32) }))).status, 400); // ct < 17
  assert.equal((await post(JSON.stringify({ id: newId(), ct: b64(20481), iv: b64(12), writeHash: b64(32) }))).status, 400); // ct over
  assert.equal((await post(JSON.stringify({ id: newId(), ct: "***", iv: b64(12), writeHash: b64(32) }))).status, 400); // bad base64url
  const e = await (await post("{}")).json();
  assert.equal(typeof e.error, "string");
  await close();
});

test("a body over 32 KB → 413", async () => {
  const { base, close } = await start();
  const r = await fetch(`${base}/api/g`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(40_000) },
    body: "x".repeat(40_000),
  });
  assert.equal(r.status, 413);
  await close();
});

test("a chunked body (no Content-Length) over 32 KB → a clean 413, not a reset", async () => {
  const { base, close } = await start();
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("x".repeat(1024)));
      c.close();
    },
  });
  const r = await fetch(`${base}/api/g`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  });
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: "body too large" });
  // The connection still works after the drained body.
  assert.equal((await fetch(`${base}/api/g/${newId()}`)).status, 404);
  await close();
});

test("auth: missing or malformed → 401, wrong token → 403, right token → 204", async () => {
  const { base, close } = await start();
  const { id, secret, grill } = await createGrill(base);
  const { writeToken } = await deriveKeys(secret);
  const blob = await sealAnswers({ v: 1, answers: grill.questions.map((q) => ({ n: q.n, kind: "skip" })) }, grill, { id, secret });
  const post = (auth) => fetch(`${base}/api/g/${id}/answers`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(blob),
  });
  assert.equal((await post(null)).status, 401);
  assert.equal((await post("Token abc")).status, 401);
  assert.equal((await post("Bearer not-base64!!")).status, 401);
  const wrong = await deriveKeys(newSecret());
  assert.equal((await post(`Bearer ${wrong.writeToken}`)).status, 403);
  assert.equal((await post(`Bearer ${writeToken}`)).status, 204);
  // DELETE the same way
  const del = (auth) => fetch(`${base}/api/g/${id}`, { method: "DELETE", headers: auth ? { authorization: auth } : {} });
  assert.equal((await del(null)).status, 401);
  assert.equal((await del(`Bearer ${wrong.writeToken}`)).status, 403);
  assert.equal((await del(`Bearer ${writeToken}`)).status, 204);
  await close();
});

test("answers: 409 when already answered, 404 for unknown id, answered flag flips", async () => {
  const { base, close } = await start();
  const { id, secret, grill } = await createGrill(base);
  const { writeToken } = await deriveKeys(secret);
  const blob = await sealAnswers({ v: 1, answers: grill.questions.map((q) => ({ n: q.n, kind: "skip" })) }, grill, { id, secret });
  const post = (target = id) => fetch(`${base}/api/g/${target}/answers`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` }, body: JSON.stringify(blob),
  });
  assert.equal((await post(newId())).status, 404);
  assert.equal((await post()).status, 204);
  assert.equal((await post()).status, 409);
  const g = await (await fetch(`${base}/api/g/${id}`)).json();
  assert.equal(g.answered, true);
  await close();
});

test("an answer moves the expiry to answer time + ttl", async () => {
  let t = 1_000_000;
  const { base, close } = await start({ now: () => t, ttlMs: 1000 });
  const { id, secret, grill } = await createGrill(base);
  const created = await (await fetch(`${base}/api/g/${id}`)).json();
  assert.equal(created.expiresAt, t + 1000);
  t += 900; // answered near the end
  const { writeToken } = await deriveKeys(secret);
  const blob = await sealAnswers({ v: 1, answers: grill.questions.map((q) => ({ n: q.n, kind: "skip" })) }, grill, { id, secret });
  await fetch(`${base}/api/g/${id}/answers`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` }, body: JSON.stringify(blob),
  });
  const g = await (await fetch(`${base}/api/g/${id}`)).json();
  assert.equal(g.expiresAt, t + 1000);
  await close();
});

test("a row past expires_at is 404 even before the sweeper runs", async () => {
  let t = 1_000_000;
  const { base, close } = await start({ now: () => t, ttlMs: 1000, sweepMs: 3_600_000 });
  const { id } = await createGrill(base);
  t += 1001;
  assert.equal((await fetch(`${base}/api/g/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/g/${id}/answers`)).status, 404);
  await close();
});

test("the sweeper deletes expired rows and counts them", async () => {
  const { base, close } = await start({ ttlMs: 60, sweepMs: 30 });
  const { id } = await createGrill(base);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await fetch(`${base}/api/g/${id}`)).status, 404);
  await close();
});

test("long poll: no wait → 204; a wait is woken by the answers", async () => {
  const { base, close } = await start();
  const { id, secret, grill } = await createGrill(base);
  assert.equal((await fetch(`${base}/api/g/${id}/answers`)).status, 204);
  const waitP = fetch(`${base}/api/g/${id}/answers?wait=10`);
  await new Promise((r) => setTimeout(r, 100));
  const answers = { v: 1, answers: grill.questions.map((q) => (q.recommend ? { n: q.n, kind: "agree" } : { n: q.n, kind: "skip" })) };
  const blob = await sealAnswers(answers, grill, { id, secret });
  const { writeToken } = await deriveKeys(secret);
  await fetch(`${base}/api/g/${id}/answers`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` }, body: JSON.stringify(blob),
  });
  const w = await waitP;
  assert.equal(w.status, 200);
  const got = await openAnswers(await w.json(), grill, { id, secret });
  assert.deepEqual(got, answers);
  // And a late arrival still gets them from storage.
  const late = await fetch(`${base}/api/g/${id}/answers`);
  assert.equal(late.status, 200);
  await close();
});

test("long poll: a timeout answers 204", async () => {
  const { base, close } = await start({ maxWaitS: 1 });
  const { id } = await createGrill(base);
  const t0 = Date.now();
  const w = await fetch(`${base}/api/g/${id}/answers?wait=1`);
  assert.equal(w.status, 204);
  assert.ok(Date.now() - t0 >= 900);
  await close();
});

test("long poll: more than 3 waiters per grill → 429; a disconnected waiter frees its slot", async () => {
  const { base, close } = await start();
  const { id } = await createGrill(base);
  const acs = [];
  for (let i = 0; i < 3; i++) {
    const ac = new AbortController();
    acs.push(ac);
    const p = fetch(`${base}/api/g/${id}/answers?wait=30`, { signal: ac.signal }).catch((e) => e);
    acs[i].p = p;
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${base}/api/g/${id}/answers?wait=1`)).status, 429);
  acs[0].abort();
  await acs[0].p;
  await new Promise((r) => setTimeout(r, 100));
  const ok = fetch(`${base}/api/g/${id}/answers?wait=1`);
  assert.equal((await ok).status, 204);
  acs.forEach((a) => a.abort());
  await close();
});

test("long poll: DELETE wakes the waiters with 404", async () => {
  const { base, close } = await start();
  const { id, secret } = await createGrill(base);
  const w = fetch(`${base}/api/g/${id}/answers?wait=30`);
  await new Promise((r) => setTimeout(r, 100));
  const { writeToken } = await deriveKeys(secret);
  await fetch(`${base}/api/g/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${writeToken}` } });
  assert.equal((await w).status, 404);
  assert.equal((await fetch(`${base}/api/g/${id}`)).status, 404);
  await close();
});

test("long poll: expiry wakes the waiters with 404", async () => {
  const { base, close } = await start({ ttlMs: 150, sweepMs: 40 });
  const { id } = await createGrill(base);
  const w = await fetch(`${base}/api/g/${id}/answers?wait=30`);
  assert.equal(w.status, 404);
  await close();
});

test("shutdown answers every waiting request 204", async () => {
  const { base, close } = await start();
  const { id } = await createGrill(base);
  const w = fetch(`${base}/api/g/${id}/answers?wait=30`);
  await new Promise((r) => setTimeout(r, 100));
  await close();
  assert.equal((await w).status, 204);
});

test("the 61st create within an hour → 429, keyed by the trusted X-Real-IP", async () => {
  const { base, close } = await start();
  const mk = (ip) => fetch(`${base}/api/g`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify({ id: newId(), ct: b64(20), iv: b64(12), writeHash: b64(32) }),
  });
  for (let i = 0; i < 60; i++) assert.equal((await mk("10.0.0.1")).status, 201);
  assert.equal((await mk("10.0.0.1")).status, 429);
  assert.equal((await mk("10.0.0.2")).status, 201); // another IP is unaffected
  await close();
});

test("persistence: a grill survives a restart of the same DB file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grill-me-"));
  const file = path.join(dir, "g.db");
  const one = await start({ db: file });
  const { id, sealed } = await createGrill(one.base);
  await one.close();
  const two = await start({ db: file });
  const g = await fetch(`${two.base}/api/g/${id}`);
  assert.equal(g.status, 200);
  assert.equal((await g.json()).ct, sealed.ct);
  await two.close();
  await rm(dir, { recursive: true, force: true });
});

test("static: routes, content types, cache and security headers", async () => {
  const { base, close } = await start();
  const get = (p) => fetch(`${base}${p}`);
  const html = await get("/");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /^text\/html/);
  assert.equal(html.headers.get("cache-control"), "public, max-age=300");
  assert.match(await html.text(), /Grill Me/);
  for (const p of ["/demo", "/hub", `/g/${newId()}`]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type"), /^text\/html/);
  }
  assert.match(await (await get("/robots.txt")).text(), /Disallow: \/g\//);
  assert.match((await get("/app.js")).headers.get("content-type"), /javascript/);
  assert.match((await get("/style.css")).headers.get("content-type"), /text\/css/);
  assert.match((await get("/ui/grill.js")).headers.get("content-type"), /javascript/);
  assert.match((await get("/ui/grill.css")).headers.get("content-type"), /text\/css/);
  assert.match((await get("/core/index.js")).headers.get("content-type"), /javascript/);
  assert.match((await get("/favicon.svg")).headers.get("content-type"), /image\/svg/);
  // security headers on every response, including a 404
  const nf = await get("/nope");
  assert.equal(nf.status, 404);
  for (const h of ["content-security-policy", "referrer-policy", "x-content-type-options", "cross-origin-opener-policy", "permissions-policy"])
    assert.ok(nf.headers.get(h), h);
  assert.match(html.headers.get("content-security-policy"), /default-src 'self'/);
  // HEAD works, POST doesn't
  const head = await fetch(`${base}/style.css`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await fetch(`${base}/style.css`, { method: "POST" })).status, 405);
  // path traversal is impossible
  assert.equal((await get("/../SPEC.md")).status, 404);
  assert.equal((await get("/%2e%2e/SPEC.md")).status, 404);
  assert.equal((await get("/core/../package.json")).status, 404);
  // bad id on the page route
  assert.equal((await get("/g/notavalidid")).status, 404);
  // API responses are no-store
  const api = await get(`/api/g/${newId()}`);
  assert.equal(api.status, 404);
  assert.equal(api.headers.get("cache-control"), "no-store");
  await close();
});

test("the access log has one line per request and never an IP address", async () => {
  const { base, close, logs } = await start();
  await fetch(`${base}/api/g/${newId()}`, { headers: { "x-real-ip": "203.0.113.7", "user-agent": "secret-agent" } });
  await fetch(`${base}/`);
  await close();
  assert.ok(logs.length >= 2);
  const line = logs.find((l) => l.includes("/api/g/"));
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.* GET \/api\/g\/\S+ 404 \d+ms$/);
  for (const l of logs) {
    assert.ok(!l.includes("203.0.113.7"), l);
    assert.ok(!l.includes("secret-agent"), l);
    assert.ok(!l.includes("?"), l); // no query strings
  }
});

test("end to end through core: seal → create → open → answer → wait → lines → delete", async () => {
  const { base, close } = await start();
  const grill = demoGrill();
  const id = newId(), secret = newSecret();
  const ids = { id, secret };
  const sealed = await sealGrill(grill, ids);
  assert.equal((await fetch(`${base}/api/g`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...sealed }),
  })).status, 201);
  // The phone opens it
  const got = await (await fetch(`${base}/api/g/${id}`)).json();
  const opened = await openGrill({ ct: got.ct, iv: got.iv }, ids);
  assert.deepEqual(opened, grill);
  // The agent waits; the phone answers
  const waitP = fetch(`${base}/api/g/${id}/answers?wait=10`);
  await new Promise((r) => setTimeout(r, 100));
  const answers = {
    v: 1,
    answers: grill.questions.map((q, i) => (i === 0 && q.recommend ? { n: q.n, kind: "agree" } : { n: q.n, kind: "skip" })),
  };
  const blob = await sealAnswers(answers, grill, ids);
  const { writeToken } = await deriveKeys(secret);
  assert.equal((await fetch(`${base}/api/g/${id}/answers`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` }, body: JSON.stringify(blob),
  })).status, 204);
  const w = await waitP;
  assert.equal(w.status, 200);
  const received = await openAnswers(await w.json(), grill, ids);
  const lines = answerLines(grill, received);
  assert.match(lines, /^Q1 - agree/m);
  assert.match(lines, /skip for now, ask again later/);
  // The agent deletes; the grill is gone
  assert.equal((await fetch(`${base}/api/g/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${writeToken}` } })).status, 204);
  assert.equal((await fetch(`${base}/api/g/${id}`)).status, 404);
  await close();
});
