import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { convert, DEMO_TEXT, newId, newSecret, sealGrill, sealAnswers, deriveKeys, b64urlDecode } from "../../core/src/index.js";

const TOKEN = "mutation-test-stats-token-0123456789abcdef";
const deferred = () => Promise.withResolvers();

async function start(t, options = {}) {
  const cleanups = [];
  const s = createServer({ statsToken: TOKEN, sweepMs: 3_600_000, ...options });
  t.after(async () => { for (const fn of cleanups) fn(); await s.close(); });
  await new Promise((r) => s.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const stats = async () => {
    const r = await fetch(`${base}/stats/data.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    return r.json();
  };
  return { base, stats, cleanups };
}

const count = (stats, name) => stats.days.filter((r) => r.name === name && r.bucket === "").reduce((sum, r) => sum + r.count, 0);

async function create(base, id = newId()) {
  const grill = convert(DEMO_TEXT).grill;
  const ids = { id, secret: newSecret() };
  const sealed = await sealGrill(grill, ids);
  const { writeToken } = await deriveKeys(ids.secret);
  const r = await fetch(`${base}/api/g`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...sealed }),
  });
  assert.equal(r.status, 201);
  const payload = async (text) => sealAnswers({
    v: 1, answers: grill.questions.map((q) => ({ n: q.n, kind: "own", text })),
  }, grill, ids);
  return { ...ids, sealed, writeToken, payload };
}

const post = (base, g, blob) => fetch(`${base}/api/g/${g.id}/answers`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${g.writeToken}` }, body: JSON.stringify(blob),
});
const remove = (base, g) => fetch(`${base}/api/g/${g.id}`, {
  method: "DELETE", headers: { authorization: `Bearer ${g.writeToken}` },
});

// Keep the real HTTP handlers and crypto. Pause only the authentication digest so every
// request definitely crosses the stale-row await window; report this as a forced schedule,
// separately from the ordinary simultaneous-request regression below.
function pauseAuth(t, scope, token, total = 1) {
  const entered = deferred(), released = deferred();
  const subtle = globalThis.crypto.subtle;
  const digest = subtle.digest;
  const bytes = Buffer.from(b64urlDecode(token));
  let n = 0;
  t.mock.method(subtle, "digest", async function (algorithm, data) {
    if (algorithm === "SHA-256" && Buffer.from(data).equals(bytes) && n < total) {
      if (++n === total) entered.resolve();
      await released.promise;
    }
    return digest.call(this, algorithm, data);
  });
  const release = () => released.resolve();
  scope.cleanups.push(release);
  return { entered: entered.promise, release };
}

async function waitForWaiter(scope) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await scope.stats()).live.waiters === 1) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("the real HTTP long-poll was not registered");
}

for (const forced of [false, true]) {
  test(`answers: 20 distinct concurrent HTTP posts have one stored/waiter/metric winner (${forced ? "auth barrier" : "ordinary scheduling"})`, { timeout: 15000 }, async (t) => {
    const scope = await start(t);
    const g = await create(scope.base);
    const blobs = await Promise.all(Array.from({ length: 20 }, (_, i) => g.payload(`Distinct answer ${i}`)));
    assert.equal(new Set(blobs.map((b) => b.ct)).size, 20);
    const waiting = fetch(`${scope.base}/api/g/${g.id}/answers?wait=10`);
    await waitForWaiter(scope);
    const gate = forced ? pauseAuth(t, scope, g.writeToken, blobs.length) : null;
    const pending = Promise.all(blobs.map((blob) => post(scope.base, g, blob)));
    if (gate) { await gate.entered; gate.release(); }
    const responses = await pending;
    const winner = responses.findIndex((r) => r.status === 204);
    assert.equal(responses.filter((r) => r.status === 204).length, 1);
    assert.equal(responses.filter((r) => r.status === 409).length, 19);
    const waiter = await waiting;
    assert.equal(waiter.status, 200);
    assert.deepEqual(await waiter.json(), blobs[winner]);
    const stored = await fetch(`${scope.base}/api/g/${g.id}/answers`);
    assert.equal(stored.status, 200);
    assert.deepEqual(await stored.json(), blobs[winner]);
    const stats = await scope.stats();
    assert.equal(count(stats, "answered"), 1);
    assert.equal(stats.days.filter((r) => r.name === "time_to_answer").reduce((n, r) => n + r.count, 0), 1);
    assert.equal(stats.live.waiters, 0);
  });
}

test("DELETE: 20 concurrent requests crossing auth delete/count/wake once; losers are 404", { timeout: 15000 }, async (t) => {
  const scope = await start(t);
  const g = await create(scope.base);
  const waiting = fetch(`${scope.base}/api/g/${g.id}/answers?wait=10`);
  await waitForWaiter(scope);
  const gate = pauseAuth(t, scope, g.writeToken, 20);
  const pending = Promise.all(Array.from({ length: 20 }, () => remove(scope.base, g)));
  await gate.entered;
  gate.release();
  const responses = await pending;
  assert.equal(responses.filter((r) => r.status === 204).length, 1);
  assert.equal(responses.filter((r) => r.status === 404).length, 19);
  assert.equal((await waiting).status, 404);
  assert.equal((await fetch(`${scope.base}/api/g/${g.id}`)).status, 404);
  const stats = await scope.stats();
  assert.equal(count(stats, "created"), 1);
  assert.equal(count(stats, "cancelled"), 1);
  assert.equal(count(stats, "picked_up"), 0);
  assert.equal(stats.live.waiters, 0);
});

test("DELETE: an answer winning during delete auth is counted as picked_up", async (t) => {
  const scope = await start(t);
  const g = await create(scope.base);
  const blob = await g.payload("Answer before delete authentication completes");
  const gate = pauseAuth(t, scope, g.writeToken);
  const pending = remove(scope.base, g);
  await gate.entered;
  assert.equal((await post(scope.base, g, blob)).status, 204);
  gate.release();
  assert.equal((await pending).status, 204);
  const stats = await scope.stats();
  assert.equal(count(stats, "answered"), 1);
  assert.equal(count(stats, "picked_up"), 1);
  assert.equal(count(stats, "cancelled"), 0);
});

test("answers: deleted during auth returns 404 without an answered metric", async (t) => {
  const scope = await start(t);
  const g = await create(scope.base);
  const blob = await g.payload("Too late");
  const gate = pauseAuth(t, scope, g.writeToken);
  const pending = post(scope.base, g, blob);
  await gate.entered;
  assert.equal((await remove(scope.base, g)).status, 204);
  gate.release();
  assert.equal((await pending).status, 404);
  const stats = await scope.stats();
  assert.equal(count(stats, "answered"), 0);
  assert.equal(count(stats, "cancelled"), 1);
});

for (const method of ["POST", "DELETE"]) {
  test(`${method}: expiry during auth returns 404 without resurrection/counting`, async (t) => {
    let clock = 1_700_000_000_000;
    const scope = await start(t, { now: () => clock, ttlMs: 1000 });
    const g = await create(scope.base);
    const blob = await g.payload("Expired while authenticating");
    const gate = pauseAuth(t, scope, g.writeToken);
    const pending = method === "POST" ? post(scope.base, g, blob) : remove(scope.base, g);
    await gate.entered;
    clock += 1000;
    gate.release();
    assert.equal((await pending).status, 404);
    assert.equal((await fetch(`${scope.base}/api/g/${g.id}`)).status, 404);
    const stats = await scope.stats();
    assert.equal(count(stats, "answered"), 0);
    assert.equal(count(stats, "cancelled"), 0);
    assert.equal(count(stats, "picked_up"), 0);
  });

  test(`${method}: delete/recreate during auth refuses the old token with 403`, async (t) => {
    const scope = await start(t);
    const g = await create(scope.base);
    const blob = await g.payload("Old-token mutation");
    const gate = pauseAuth(t, scope, g.writeToken);
    const pending = method === "POST" ? post(scope.base, g, blob) : remove(scope.base, g);
    await gate.entered;
    assert.equal((await remove(scope.base, g)).status, 204);
    const replacement = await create(scope.base, g.id);
    assert.notEqual(replacement.writeToken, g.writeToken);
    gate.release();
    assert.equal((await pending).status, 403);
    const got = await fetch(`${scope.base}/api/g/${g.id}`);
    assert.equal(got.status, 200);
    const row = await got.json();
    assert.equal(row.ct, replacement.sealed.ct);
    assert.equal(row.iv, replacement.sealed.iv);
    assert.equal(row.answered, false);
    const stats = await scope.stats();
    assert.equal(count(stats, "created"), 2);
    assert.equal(count(stats, "answered"), 0);
    assert.equal(count(stats, "cancelled"), 1);
    assert.equal(count(stats, "picked_up"), 0);
  });
}
