import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../src/server.js";
import {
  convert, DEMO_TEXT, newId, newSecret, answerLines, b64urlEncode,
  deriveSessionKeys, sealGrill, sealRound, openRound, sealRoundAnswers, openRoundAnswers,
} from "../../core/src/index.js";

const STATS_TOKEN = "s".repeat(40);

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
    statsToken: opts.statsToken ?? "",
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let closing;
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => (closing ??= close()), logs };
}

const demoGrill = () => convert(DEMO_TEXT).grill;
const skips = (grill) => ({ v: 1, answers: grill.questions.map((q) => ({ n: q.n, kind: "skip" })) });
const bearer = (keys) => ({ authorization: `Bearer ${keys.writeToken}` });
const json = (extra = {}) => ({ "content-type": "application/json", ...extra });
const b64bytes = (n) => b64urlEncode(new Uint8Array(n).fill(1));

// Creates a real session round 1 through core; returns everything a caller needs.
async function createSession(base, { grill = demoGrill(), id, secret } = {}) {
  id ??= newId();
  secret ??= newSecret();
  const ids = { id, secret, round: 1 };
  const sealed = await sealRound(grill, ids);
  const keys = await deriveSessionKeys(secret);
  const operationId = newId();
  const res = await fetch(`${base}/api/s`, {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ id, round: 1, operationId, ct: sealed.ct, iv: sealed.iv, writeHash: sealed.writeHash }),
  });
  return { id, secret, ids, grill, sealed, keys, operationId, res };
}

async function answerRound(base, sess, round, revision, answers) {
  const blob = await sealRoundAnswers(answers, sess.grill, { id: sess.id, secret: sess.secret, round });
  const submissionId = newId();
  const res = await fetch(`${base}/api/s/${sess.id}/rounds/${round}/answers`, {
    method: "POST",
    headers: json(bearer(sess.keys)),
    body: JSON.stringify({ expectedRevision: revision, submissionId, ct: blob.ct, iv: blob.iv }),
  });
  return { res, submissionId, blob };
}

const ackRound = (base, sess, round, revision, submissionId) =>
  fetch(`${base}/api/s/${sess.id}/rounds/${round}/ack`, {
    method: "POST",
    headers: json(bearer(sess.keys)),
    body: JSON.stringify({ expectedRevision: revision, submissionId }),
  });

const getSnapshot = async (base, id, query = "") => {
  const r = await fetch(`${base}/api/s/${id}${query}`);
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
};

async function statsCounts(base) {
  const r = await fetch(`${base}/stats/data.json`, { headers: bearer({ writeToken: STATS_TOKEN }) });
  assert.equal(r.status, 200);
  const out = {};
  for (const row of (await r.json()).days) {
    const k = row.bucket ? `${row.name}/${row.bucket}` : row.name;
    out[k] = (out[k] || 0) + row.count;
  }
  return out;
}

async function sealGrillFor(base, id) {
  const secret = newSecret();
  const sealed = await sealGrill(demoGrill(), { id, secret });
  return fetch(`${base}/api/g`, { method: "POST", headers: json(), body: JSON.stringify({ id, ...sealed }) });
}

test("create round 1 → 201 snapshot; GET snapshot is pending with the current ciphertext", async (ctx) => {
  const { base, close } = await start();
  ctx.after(close);
  const s = await createSession(base);
  assert.equal(s.res.status, 201);
  const b = await s.res.json();
  assert.deepEqual(Object.keys(b), ["v", "id", "round", "revision", "state", "expiresAt", "operationId", "ct", "iv"]);
  assert.equal(b.v, 2);
  assert.equal(b.id, s.id);
  assert.deepEqual([b.round, b.revision, b.state], [1, 1, "pending"]);
  assert.equal(b.operationId, s.operationId);
  assert.equal(b.ct, s.sealed.ct);
  assert.equal(b.iv, s.sealed.iv);
  const got = await getSnapshot(base, s.id);
  assert.equal(got.status, 200);
  assert.deepEqual(await openRound({ ct: got.body.ct, iv: got.body.iv }, s.ids), s.grill);
  assert.equal(typeof got.body.expiresAt, "number");
  // after=current with no wait → 204; after differs → immediate 200; bad after → 400
  assert.equal((await fetch(`${base}/api/s/${s.id}?after=1`)).status, 204);
  assert.equal((await fetch(`${base}/api/s/${s.id}?after=0`)).status, 200);
  assert.equal((await fetch(`${base}/api/s/${s.id}?after=-1`)).status, 400);
  assert.equal((await fetch(`${base}/api/s/${s.id}?after=x`)).status, 400);
  await close();
});

test("create validation → 400; unknown or malformed routes → 404/405/400", async (ctx) => {
  const { base, close } = await start();
  ctx.after(close);
  const good = await createSession(base);
  const post = (body) => fetch(`${base}/api/s`, { method: "POST", headers: json(), body: JSON.stringify(body) });
  const sealed = await sealRound(demoGrill(), { id: newId(), secret: newSecret(), round: 1 });
  assert.equal((await post({ id: newId(), round: 2, operationId: newId(), ct: sealed.ct, iv: sealed.iv, writeHash: sealed.writeHash })).status, 400); // round must be 1
  assert.equal((await post({ id: newId(), round: 1, operationId: "short", ct: sealed.ct, iv: sealed.iv, writeHash: sealed.writeHash })).status, 400);
  assert.equal((await post({ id: newId(), round: 1, operationId: newId(), ct: sealed.ct, iv: sealed.iv, writeHash: sealed.writeHash.slice(0, 40) })).status, 400);
  assert.equal((await post({ id: newId(), round: 1, operationId: newId(), ct: sealed.ct.slice(0, 20), iv: sealed.iv, writeHash: sealed.writeHash })).status, 400);
  assert.equal((await post({ id: "!!", round: 1, operationId: newId(), ct: sealed.ct, iv: sealed.iv, writeHash: sealed.writeHash })).status, 400);
  assert.equal((await fetch(`${base}/api/s`, { method: "GET" })).status, 405);
  assert.equal((await fetch(`${base}/api/s/${good.id}`, { method: "PUT" })).status, 405);
  assert.equal((await fetch(`${base}/api/s/notavalidid`)).status, 404);
  assert.equal((await fetch(`${base}/api/s/${good.id}/bogus`)).status, 404);
  assert.equal((await fetch(`${base}/api/s/${good.id}/rounds`)).status, 405);
  assert.equal((await fetch(`${base}/api/s/${good.id}/rounds/abc/answers`, { method: "POST", headers: json(), body: "{}" })).status, 400);
  // a body over 32 KB → 413, like every other route
  const big = await fetch(`${base}/api/s`, { method: "POST", headers: { "content-type": "application/json", "content-length": "40000" }, body: "x".repeat(40000) });
  assert.equal(big.status, 413);
  await close();
});

test("exact create retry → 200 snapshot without mutation or extra metric; conflicting id → 409", async (ctx) => {
  const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
  const s = await createSession(base);
  assert.equal(s.res.status, 201);
  const retryBody = JSON.stringify({ id: s.id, round: 1, operationId: s.operationId, ct: s.sealed.ct, iv: s.sealed.iv, writeHash: s.sealed.writeHash });
  const retry = await fetch(`${base}/api/s`, { method: "POST", headers: json(), body: retryBody });
  assert.equal(retry.status, 200);
  const rb = await retry.json();
  assert.deepEqual([rb.round, rb.revision, rb.state], [1, 1, "pending"]);
  // Retry again after the state advanced to answered: still a 200 snapshot of current state.
  const a = await answerRound(base, s, 1, 1, skips(s.grill));
  assert.equal(a.res.status, 204);
  const late = await fetch(`${base}/api/s`, { method: "POST", headers: json(), body: retryBody });
  assert.equal(late.status, 200);
  assert.equal((await late.json()).state, "answered");
  // A conflicting create under the same id → 409, and the row is untouched.
  const other = await sealRound(s.grill, { id: s.id, secret: newSecret(), round: 1 });
  const conflict = await fetch(`${base}/api/s`, {
    method: "POST", headers: json(),
    body: JSON.stringify({ id: s.id, round: 1, operationId: newId(), ct: other.ct, iv: other.iv, writeHash: other.writeHash }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await getSnapshot(base, s.id)).body.state, "answered");
  const counts = await statsCounts(base);
  assert.equal(counts["session_created"], 1); // retries added no metric
  await close();
});

test("namespaces reject duplicate ids across both tables", async (ctx) => {
  const { base, close } = await start();
  ctx.after(close);
  const grillId = newId();
  assert.equal((await sealGrillFor(base, grillId)).status, 201);
  const s = await sealRound(demoGrill(), { id: grillId, secret: newSecret(), round: 1 });
  const clash1 = await fetch(`${base}/api/s`, {
    method: "POST", headers: json(),
    body: JSON.stringify({ id: grillId, round: 1, operationId: newId(), ct: s.ct, iv: s.iv, writeHash: s.writeHash }),
  });
  assert.equal(clash1.status, 409);
  const sess = await createSession(base);
  const clash2 = await fetch(`${base}/api/g`, {
    method: "POST", headers: json(),
    body: JSON.stringify({ id: sess.id, ct: sess.sealed.ct, iv: sess.sealed.iv, writeHash: sess.sealed.writeHash }),
  });
  assert.equal(clash2.status, 409);
  await close();
});

test("publish: only idle + exact revision + round = current+1; exact retry 200; same operationId with different request 409", async (ctx) => {
  const { base, close } = await start();
  ctx.after(close);
  const s = await createSession(base);
  const sealed2 = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 2 });
  const pub = (round, rev, op, blob) => fetch(`${base}/api/s/${s.id}/rounds`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ round, expectedRevision: rev, operationId: op, ct: blob.ct, iv: blob.iv }),
  });
  // pending: not publishable
  assert.equal((await pub(2, 1, newId(), sealed2)).status, 409);
  // answer + ack → idle at revision 3
  const a = await answerRound(base, s, 1, 1, skips(s.grill));
  assert.equal(a.res.status, 204);
  assert.equal((await ackRound(base, s, 1, 2, a.submissionId)).status, 204);
  // wrong revision, skipped round
  assert.equal((await pub(2, 2, newId(), sealed2)).status, 409);
  const sealed3 = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 3 });
  assert.equal((await pub(3, 3, newId(), sealed3)).status, 409);
  // the winning publish
  const op2 = newId();
  const won = await pub(2, 3, op2, sealed2);
  assert.equal(won.status, 201);
  const wb = await won.json();
  assert.deepEqual([wb.round, wb.revision, wb.state], [2, 4, "pending"]);
  assert.equal(wb.ct, sealed2.ct);
  // exact retry → 200, no mutation
  assert.equal((await pub(2, 3, op2, sealed2)).status, 200);
  const rb = await getSnapshot(base, s.id);
  assert.deepEqual([rb.body.round, rb.body.revision], [2, 4]);
  // same operationId, different blob → 409; same blob, different operationId → 409
  const other = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 2 });
  assert.equal((await pub(2, 3, op2, other)).status, 409);
  assert.equal((await pub(2, 3, newId(), sealed2)).status, 409);
  // round 2 while round 2 is pending → 409
  assert.equal((await pub(2, 4, newId(), sealed2)).status, 409);
  await close();
});

test("answers: one winner 204; identical retry 200 without mutation; conflicting/different/stale/cross-round 409", async (ctx) => {
  const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
  const s = await createSession(base);
  const answers = skips(s.grill);
  const a = await answerRound(base, s, 1, 1, answers);
  assert.equal(a.res.status, 204);
  // identical retry (same submission, same blob) → 200, no mutation
  const retry = await fetch(`${base}/api/s/${s.id}/rounds/1/answers`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ expectedRevision: 1, submissionId: a.submissionId, ct: a.blob.ct, iv: a.blob.iv }),
  });
  assert.equal(retry.status, 200);
  assert.equal((await getSnapshot(base, s.id)).body.revision, 2);
  // a different submission (same blob) and a tampered blob (same submission) → 409
  const b = await fetch(`${base}/api/s/${s.id}/rounds/1/answers`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ expectedRevision: 1, submissionId: newId(), ct: a.blob.ct, iv: a.blob.iv }),
  });
  assert.equal(b.status, 409);
  const tampered = await sealRoundAnswers(answers, s.grill, s.ids);
  const c = await fetch(`${base}/api/s/${s.id}/rounds/1/answers`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ expectedRevision: 1, submissionId: a.submissionId, ct: tampered.ct, iv: tampered.iv }),
  });
  assert.equal(c.status, 409);
  // stale expectedRevision → 409
  const stale = await fetch(`${base}/api/s/${s.id}/rounds/1/answers`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ expectedRevision: 99, submissionId: newId(), ct: a.blob.ct, iv: a.blob.iv }),
  });
  assert.equal(stale.status, 409);
  // the agent reads the answers back and decrypts them
  const got = await fetch(`${base}/api/s/${s.id}/rounds/1/answers`);
  assert.equal(got.status, 200);
  const gb = await got.json();
  assert.deepEqual([gb.round, gb.revision, gb.submissionId], [1, 2, a.submissionId]);
  assert.deepEqual(await openRoundAnswers({ ct: gb.ct, iv: gb.iv }, s.grill, s.ids), answers);
  assert.match(answerLines(s.grill, await openRoundAnswers({ ct: gb.ct, iv: gb.iv }, s.grill, s.ids)), /skip for now/);
  const counts = await statsCounts(base);
  assert.equal(counts["session_answered"], 1); // the retry added no metric
  await close();
});

test("cross-round answers are never accepted: round 2 answers on round 1 → 409; agent poll on wrong round → 409", async (ctx) => {
  const { base, close } = await start();
  ctx.after(close);
  const s = await createSession(base);
  const a = await answerRound(base, s, 2, 1, skips(s.grill)); // round 2 does not exist yet
  assert.equal(a.res.status, 409);
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds/2/answers`)).status, 409);
  // advance to round 2 properly
  const a1 = await answerRound(base, s, 1, 1, skips(s.grill));
  await ackRound(base, s, 1, 2, a1.submissionId);
  const sealed2 = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 2 });
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ round: 2, expectedRevision: 3, operationId: newId(), ct: sealed2.ct, iv: sealed2.iv }),
  })).status, 201);
  // round 1 is history: no endpoint serves it
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds/1/answers`)).status, 409);
  const stale = await fetch(`${base}/api/s/${s.id}/rounds/1/answers`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ expectedRevision: 1, submissionId: a1.submissionId, ct: a1.blob.ct, iv: a1.blob.iv }),
  });
  assert.equal(stale.status, 409); // an exact old answer retry after a newer round 409s
  const snap = await getSnapshot(base, s.id);
  assert.equal(snap.body.round, 2);
  assert.equal(snap.body.ct, sealed2.ct); // only the current round's ciphertext
  await close();
});

test("ack: matching answered → 204 erases both slots; exact replay 204; changed-version or different-submission retry 409; lower round 204", async (ctx) => {
  const dir = await mkdtemp(path.join(tmpdir(), "grill-me-sess-"));
  const file = path.join(dir, "s.db");
  const { base, close } = await start({ db: file });
  ctx.after(close);
  const s = await createSession(base);
  const a = await answerRound(base, s, 1, 1, skips(s.grill));
  // wrong submission / wrong revision → 409
  assert.equal((await ackRound(base, s, 1, 2, newId())).status, 409);
  assert.equal((await ackRound(base, s, 1, 99, a.submissionId)).status, 409);
  // ack while pending → 409
  const other = await createSession(base);
  assert.equal((await ackRound(base, other, 1, 1, newId())).status, 409);
  // the matching ack wins
  assert.equal((await ackRound(base, s, 1, 2, a.submissionId)).status, 204);
  // both ciphertext slots are erased: snapshot is idle with no ciphertext, agent poll 204
  const snap = await getSnapshot(base, s.id);
  assert.deepEqual([snap.body.state, snap.body.revision], ["idle", 3]);
  assert.ok(!("ct" in snap.body) && !("iv" in snap.body) && !("submissionId" in snap.body));
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds/1/answers`)).status, 204);
  // retained state on disk: digests and identities stay, ciphertext is gone (current-only storage)
  const dbh = new DatabaseSync(file);
  const row = dbh.prepare("SELECT * FROM sessions WHERE id = ?").get(s.id);
  assert.equal(row.ct, null);
  assert.equal(row.iv, null);
  assert.equal(row.ans_ct, null);
  assert.equal(row.ans_iv, null);
  assert.ok(row.op_digest && row.sub_digest);
  assert.equal(row.sub_id, a.submissionId);
  assert.equal(row.sub_rev, 1); // the original pending revision supplied by the answer request
  assert.equal(row.state, "idle");
  dbh.close();
  // exact replay of the ack (same submission, same original revision) → 204 no-op;
  // the same submission with a changed revision → 409
  assert.equal((await ackRound(base, s, 1, 2, a.submissionId)).status, 204);
  assert.equal((await ackRound(base, s, 1, 999, a.submissionId)).status, 409);
  assert.equal((await ackRound(base, s, 1, 3, newId())).status, 409);
  // publish round 2, then acks for older/newer rounds
  const sealed2 = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 2 });
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ round: 2, expectedRevision: 3, operationId: newId(), ct: sealed2.ct, iv: sealed2.iv }),
  })).status, 201);
  assert.equal((await ackRound(base, s, 1, 2, a.submissionId)).status, 204); // lower round: no-op
  assert.equal((await ackRound(base, s, 3, 4, newId())).status, 409); // newer round: never touched
  const afterStale = await getSnapshot(base, s.id);
  assert.deepEqual([afterStale.body.round, afterStale.body.revision, afterStale.body.state], [2, 4, "pending"]);
  assert.equal(afterStale.body.ct, sealed2.ct);
  await close();
  await rm(dir, { recursive: true, force: true });
});

test("finish: only idle at the exact revision; afterwards everything is 404", async (ctx) => {
  const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
  const s = await createSession(base);
  const fin = (rev) => fetch(`${base}/api/s/${s.id}/finish`, { method: "POST", headers: json(bearer(s.keys)), body: JSON.stringify({ expectedRevision: rev }) });
  assert.equal((await fin(1)).status, 409); // pending
  const a = await answerRound(base, s, 1, 1, skips(s.grill));
  assert.equal((await fin(2)).status, 409); // answered
  await ackRound(base, s, 1, 2, a.submissionId);
  assert.equal((await fin(99)).status, 409); // wrong revision
  assert.equal((await fin(3)).status, 204);
  assert.equal((await getSnapshot(base, s.id)).status, 404);
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds/1/answers`)).status, 404);
  assert.equal((await fin(3)).status, 404);
  assert.equal((await fetch(`${base}/api/s/${s.id}`, { method: "DELETE", headers: json(bearer(s.keys)) })).status, 404);
  const counts = await statsCounts(base);
  assert.equal(counts["session_finished"], 1);
  await close();
});

test("DELETE cancels any state with auth; a cancelled session is 404 everywhere", async (ctx) => {
  const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
  const s = await createSession(base);
  const answersBlob = await sealRoundAnswers(skips(s.grill), s.grill, s.ids);
  // 401/403 on every authenticated session route
  for (const [method, path, body] of [
    ["POST", `/api/s/${s.id}/rounds`, { round: 2, expectedRevision: 1, operationId: newId(), ct: s.sealed.ct, iv: s.sealed.iv }],
    ["POST", `/api/s/${s.id}/rounds/1/answers`, { expectedRevision: 1, submissionId: newId(), ct: answersBlob.ct, iv: answersBlob.iv }],
    ["POST", `/api/s/${s.id}/rounds/1/ack`, { expectedRevision: 1, submissionId: newId() }],
    ["POST", `/api/s/${s.id}/finish`, { expectedRevision: 1 }],
    ["DELETE", `/api/s/${s.id}`, null],
  ]) {
    const noAuth = await fetch(`${base}${path}`, { method, headers: json(), ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(noAuth.status, 401, `${method} ${path} without token`);
    const wrong = await deriveSessionKeys(newSecret());
    const badAuth = await fetch(`${base}${path}`, { method, headers: json(bearer(wrong)), ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(badAuth.status, 403, `${method} ${path} with wrong token`);
  }
  // the state is untouched by the failed auths
  assert.equal((await getSnapshot(base, s.id)).body.state, "pending");
  // cancel from pending works
  assert.equal((await fetch(`${base}/api/s/${s.id}`, { method: "DELETE", headers: json(bearer(s.keys)) })).status, 204);
  assert.equal((await getSnapshot(base, s.id)).status, 404);
  const counts = await statsCounts(base);
  assert.equal(counts["session_cancelled"], 1);
  // cancel from answered works too
  const s2 = await createSession(base);
  const a2 = await answerRound(base, s2, 1, 1, skips(s2.grill));
  assert.equal(a2.res.status, 204);
  assert.equal((await fetch(`${base}/api/s/${s2.id}`, { method: "DELETE", headers: json(bearer(s2.keys)) })).status, 204);
  assert.equal((await fetch(`${base}/api/s/${s2.id}/rounds/1/answers`)).status, 404);
  await close();
});

test("expiry: past expires_at is 404 before the sweeper; transitions refresh expiry; reads never extend it", async (ctx) => {
  let t = 1_000_000;
  const { base, close } = await start({ now: () => t, ttlMs: 1000, sweepMs: 3_600_000 });
  ctx.after(close);
  const s = await createSession(base);
  const exp = async () => (await getSnapshot(base, s.id)).body.expiresAt;
  assert.equal(await exp(), t + 1000);
  t += 400;
  const a = await answerRound(base, s, 1, 1, skips(s.grill)); // answered at t
  assert.equal(a.res.status, 204);
  assert.equal(await exp(), t + 1000);
  t += 200;
  await ackRound(base, s, 1, 2, a.submissionId); // acked at t
  assert.equal(await exp(), t + 1000);
  t += 100;
  const sealed2 = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 2 });
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ round: 2, expectedRevision: 3, operationId: newId(), ct: sealed2.ct, iv: sealed2.iv }),
  })).status, 201); // published at t
  assert.equal(await exp(), t + 1000);
  t += 500; // total 1200 > the original create+1000, but reads never extend
  const snap = await getSnapshot(base, s.id);
  assert.equal(snap.status, 200);
  assert.equal(snap.body.expiresAt, t + 500); // still the publish-time refresh
  t += 501; // now past expiry
  assert.equal((await getSnapshot(base, s.id)).status, 404);
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds/2/answers`)).status, 404);
  assert.equal((await fetch(`${base}/api/s/${s.id}/finish`, { method: "POST", headers: json(bearer(s.keys)), body: JSON.stringify({ expectedRevision: 4 }) })).status, 404);
  await close();
});

test("a waiting poll re-evaluates on timeout: an expired session is 404 without the sweeper", async (ctx) => {
  let t = 1_000_000;
  const { base, close } = await start({ now: () => t, ttlMs: 1000, sweepMs: 3_600_000, maxWaitS: 1 });
  ctx.after(close);
  const s = await createSession(base);
  t += 1001; // expire without the sweeper ever running
  const r = await fetch(`${base}/api/s/${s.id}?after=1&wait=1`);
  assert.equal(r.status, 404);
  const w = await fetch(`${base}/api/s/${s.id}/rounds/1/answers?wait=1`);
  assert.equal(w.status, 404);
  await close();
});

test("the sweeper deletes expired sessions, counts them and wakes polls with 404", async (ctx) => {
  const { base, close } = await start({ ttlMs: 150, sweepMs: 40, statsToken: STATS_TOKEN });
  ctx.after(close);
  const s = await createSession(base);
  const w = fetch(`${base}/api/s/${s.id}?after=1&wait=30`);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await w).status, 404);
  assert.equal((await getSnapshot(base, s.id)).status, 404);
  const counts = await statsCounts(base);
  assert.equal(counts["session_expired/unanswered"], 1);
  await close();
});

test("long poll: phone waits on after=revision and wakes on answer, ack, next round and finish", async (ctx) => {
  const { base, close } = await start({ maxWaitS: 5 });
  ctx.after(close);
  const s = await createSession(base);
  // answer wakes the phone with an answered snapshot
  const p1 = fetch(`${base}/api/s/${s.id}?after=1&wait=5`);
  await new Promise((r) => setTimeout(r, 100));
  const a = await answerRound(base, s, 1, 1, skips(s.grill));
  assert.equal(a.res.status, 204);
  const r1 = await p1;
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).state, "answered");
  // ack wakes it with an idle snapshot (no ciphertext)
  const p2 = fetch(`${base}/api/s/${s.id}?after=2&wait=5`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await ackRound(base, s, 1, 2, a.submissionId)).status, 204);
  const snap2 = await (await p2).json();
  assert.deepEqual([snap2.state, snap2.round, snap2.revision], ["idle", 1, 3]);
  assert.ok(!("ct" in snap2));
  // the next round mounts automatically with the new ciphertext
  const sealed2 = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 2 });
  const p3 = fetch(`${base}/api/s/${s.id}?after=3&wait=5`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ round: 2, expectedRevision: 3, operationId: newId(), ct: sealed2.ct, iv: sealed2.iv }),
  })).status, 201);
  const snap3 = await (await p3).json();
  assert.deepEqual([snap3.state, snap3.round], ["pending", 2]);
  assert.deepEqual(await openRound({ ct: snap3.ct, iv: snap3.iv }, { id: s.id, secret: s.secret, round: 2 }), s.grill);
  // finish wakes the phone with 404 gone
  const a2 = await answerRound(base, s, 2, 4, skips(s.grill));
  assert.equal(a2.res.status, 204);
  assert.equal((await ackRound(base, s, 2, 5, a2.submissionId)).status, 204);
  const p4 = fetch(`${base}/api/s/${s.id}?after=6&wait=5`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${base}/api/s/${s.id}/finish`, { method: "POST", headers: json(bearer(s.keys)), body: JSON.stringify({ expectedRevision: 6 }) })).status, 204);
  assert.equal((await p4).status, 404);
  // a quiet wait times out 204
  const s2 = await createSession(base);
  assert.equal((await fetch(`${base}/api/s/${s2.id}?after=1&wait=1`)).status, 204);
  await close();
});

test("agent answer poll: 200 with the winner's ciphertext once answered; wakes once", async (ctx) => {
  const { base, close } = await start();
  ctx.after(close);
  const s = await createSession(base);
  assert.equal((await fetch(`${base}/api/s/${s.id}/rounds/1/answers`)).status, 204);
  const waitP = fetch(`${base}/api/s/${s.id}/rounds/1/answers?wait=10`);
  await new Promise((r) => setTimeout(r, 100));
  const answers = skips(s.grill);
  const a = await answerRound(base, s, 1, 1, answers);
  assert.equal(a.res.status, 204);
  const w = await waitP;
  assert.equal(w.status, 200);
  const wb = await w.json();
  assert.equal(wb.submissionId, a.submissionId);
  assert.deepEqual(await openRoundAnswers({ ct: wb.ct, iv: wb.iv }, s.grill, s.ids), answers);
  // a second waiter started late still reads the stored answers
  const late = await fetch(`${base}/api/s/${s.id}/rounds/1/answers`);
  assert.equal(late.status, 200);
  await close();
});

test("concurrent answers: exactly one winner, identical retries 200, differing 409, single metric, one wake", async (ctx) => {
  const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
  const s = await createSession(base);
  const answers = skips(s.grill);
  const winner = await answerRound(base, s, 1, 1, answers); // built once; reused byte-identically
  assert.equal(winner.res.status, 204);
  const waitP = fetch(`${base}/api/s/${s.id}/rounds/1/answers?wait=10`);
  const identicalBody = JSON.stringify({ expectedRevision: 1, submissionId: winner.submissionId, ct: winner.blob.ct, iv: winner.blob.iv });
  const fire = (body) => fetch(`${base}/api/s/${s.id}/rounds/1/answers`, { method: "POST", headers: json(bearer(s.keys)), body });
  const results = await Promise.all([
    fire(identicalBody), fire(identicalBody), fire(identicalBody), fire(identicalBody),
    // differing: same blob with different submissionIds, and a fresh blob
    fire(JSON.stringify({ expectedRevision: 1, submissionId: newId(), ct: winner.blob.ct, iv: winner.blob.iv })),
    fire(JSON.stringify({ expectedRevision: 1, submissionId: newId(), ct: winner.blob.ct, iv: winner.blob.iv })),
    (async () => {
      const fresh = await sealRoundAnswers(answers, s.grill, s.ids);
      return fire(JSON.stringify({ expectedRevision: 1, submissionId: newId(), ct: fresh.ct, iv: fresh.iv }));
    })(),
    fire(JSON.stringify({ expectedRevision: 99, submissionId: winner.submissionId, ct: winner.blob.ct, iv: winner.blob.iv })), // stale revision
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 409, 409, 409, 409].sort());
  const w = await waitP;
  assert.equal(w.status, 200);
  const wb = await w.json();
  assert.equal(wb.submissionId, winner.submissionId); // the waiter saw exactly the winning ciphertext
  assert.deepEqual(await openRoundAnswers({ ct: wb.ct, iv: wb.iv }, s.grill, s.ids), answers);
  const snap = await getSnapshot(base, s.id);
  assert.equal(snap.body.revision, 2); // no retry mutated anything
  const counts = await statsCounts(base);
  assert.equal(counts["session_answered"], 1);
  await close();
});

test("concurrent publishes: exactly one winner; identical retries 200 without extra revision bump", async (ctx) => {
  const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
  const s = await createSession(base);
  const a = await answerRound(base, s, 1, 1, skips(s.grill));
  assert.equal(a.res.status, 204);
  assert.equal((await ackRound(base, s, 1, 2, a.submissionId)).status, 204);
  // ten distinct operations race; exactly one may win
  const pubs = [];
  for (let i = 0; i < 10; i++) {
    const sealed = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 2 });
    pubs.push({ body: JSON.stringify({ round: 2, expectedRevision: 3, operationId: newId(), ct: sealed.ct, iv: sealed.iv }) });
  }
  const results = await Promise.all(pubs.map((p) =>
    fetch(`${base}/api/s/${s.id}/rounds`, { method: "POST", headers: json(bearer(s.keys)), body: p.body })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  const snap = await getSnapshot(base, s.id);
  assert.deepEqual([snap.body.round, snap.body.revision, snap.body.state], [2, 4, "pending"]);
  // ten identical publishes race; one 201, nine 200 snapshots, revision moves once
  const sealed = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 3 });
  const a2 = await answerRound(base, s, 2, 4, skips(s.grill));
  assert.equal(a2.res.status, 204);
  assert.equal((await ackRound(base, s, 2, 5, a2.submissionId)).status, 204);
  const body = JSON.stringify({ round: 3, expectedRevision: 6, operationId: newId(), ct: sealed.ct, iv: sealed.iv });
  const results2 = await Promise.all(Array.from({ length: 10 }, () =>
    fetch(`${base}/api/s/${s.id}/rounds`, { method: "POST", headers: json(bearer(s.keys)), body })));
  assert.equal(results2.filter((r) => r.status === 201).length, 1);
  assert.equal(results2.filter((r) => r.status === 200).length, 9);
  const snap2 = await getSnapshot(base, s.id);
  assert.deepEqual([snap2.body.round, snap2.body.revision], [3, 7]);
  const counts = await statsCounts(base);
  assert.equal(counts["session_created"], 1);
  await close();
});

test("auth-window race: an answer authenticated against a row deleted mid-auth loses; replacement by a new key → 403", async (ctx) => {
  const subtle = globalThis.crypto.subtle;
  const origDigest = subtle.digest.bind(subtle);
  let hold = null;
  let captured = 0;
  subtle.digest = (alg, data) => {
    const p = origDigest(alg, data);
    if (hold) { captured++; const h = hold; hold = null; return p.then((r) => h.then(() => r)); }
    return p;
  };
  const waitCaptured = async () => {
    for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(captured, "the request's auth digest was held");
  };
  try {
    // Part 1: DELETE wins while the answer's auth digest is held → the answer gets 404, no metric.
    {
      const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
      const s = await createSession(base);
      hold = new Promise((r) => { globalThis.__releaseHold = r; });
      captured = 0;
      const a = answerRound(base, s, 1, 1, skips(s.grill));
      await waitCaptured();
      const del = await fetch(`${base}/api/s/${s.id}`, { method: "DELETE", headers: json(bearer(s.keys)) });
      assert.equal(del.status, 204);
      globalThis.__releaseHold();
      const ares = await a;
      assert.equal(ares.res.status, 404); // no winner claim after deletion
      const counts = await statsCounts(base);
      assert.equal(counts["session_answered"] || 0, 0);
      await close();
    }
    // Part 2: the id is recreated with a new key before the held auth finishes → 403, new row intact.
    {
      const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
      const s = await createSession(base);
      const oldBlob = await sealRoundAnswers(skips(s.grill), s.grill, s.ids);
      hold = new Promise((r) => { globalThis.__releaseHold = r; });
      captured = 0;
      const stale = fetch(`${base}/api/s/${s.id}/rounds/1/answers`, {
        method: "POST", headers: json(bearer(s.keys)),
        body: JSON.stringify({ expectedRevision: 1, submissionId: newId(), ct: oldBlob.ct, iv: oldBlob.iv }),
      });
      await waitCaptured();
      assert.equal((await fetch(`${base}/api/s/${s.id}`, { method: "DELETE", headers: json(bearer(s.keys)) })).status, 204);
      const secret2 = newSecret();
      const sealed = await sealRound(s.grill, { id: s.id, secret: secret2, round: 1 });
      const rec = await fetch(`${base}/api/s`, {
        method: "POST", headers: json(),
        body: JSON.stringify({ id: s.id, round: 1, operationId: newId(), ct: sealed.ct, iv: sealed.iv, writeHash: sealed.writeHash }),
      });
      assert.equal(rec.status, 201);
      globalThis.__releaseHold();
      assert.equal((await stale).status, 403); // old token, recreated row
      const snap = await getSnapshot(base, s.id);
      assert.equal(snap.body.state, "pending"); // the new session is untouched
      assert.deepEqual(await openRound({ ct: snap.body.ct, iv: snap.body.iv }, { id: s.id, secret: secret2, round: 1 }), s.grill);
      await close();
    }
  } finally {
    subtle.digest = origDigest;
  }
});

test("concurrent finish and delete: exactly one transition wins", async (ctx) => {
  const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
  const s = await createSession(base);
  const a = await answerRound(base, s, 1, 1, skips(s.grill));
  await ackRound(base, s, 1, 2, a.submissionId);
  const fin = fetch(`${base}/api/s/${s.id}/finish`, { method: "POST", headers: json(bearer(s.keys)), body: JSON.stringify({ expectedRevision: 3 }) });
  const del = fetch(`${base}/api/s/${s.id}`, { method: "DELETE", headers: json(bearer(s.keys)) });
  const [rf, rd] = await Promise.all([fin, del]);
  assert.deepEqual([rf.status, rd.status].sort(), [204, 404].sort()); // one deletion, one already-ended
  assert.equal((await getSnapshot(base, s.id)).status, 404);
  const counts = await statsCounts(base);
  assert.equal((counts["session_finished"] || 0) + (counts["session_cancelled"] || 0), 1);
  await close();
});

test("waiter budgets are shared between legacy grills and sessions", async (ctx) => {
  const { base, close } = await start({ waitersPerGrill: 3, waitersPerIp: 3 });
  ctx.after(close);
  const s = await createSession(base);
  const g = newId();
  assert.equal((await sealGrillFor(base, g)).status, 201);
  const acs = [];
  for (let i = 0; i < 3; i++) {
    const ac = new AbortController();
    acs.push(ac);
    ac.p = fetch(`${base}/api/s/${s.id}?after=1&wait=30`, { signal: ac.signal }).catch((e) => e);
  }
  await new Promise((r) => setTimeout(r, 100));
  // the per-id cap counts both namespaces
  assert.equal((await fetch(`${base}/api/s/${s.id}?after=1&wait=1`)).status, 429);
  acs.forEach((a) => a.abort());
  await Promise.all(acs.map((a) => a.p));
  await new Promise((r) => setTimeout(r, 100));
  // per-IP budget shared: 2 session waiters + 1 legacy waiter exhaust the three slots
  const w1 = fetch(`${base}/api/s/${s.id}?after=1&wait=30`).catch((e) => e);
  const w2 = fetch(`${base}/api/s/${s.id}?after=1&wait=30`).catch((e) => e);
  const w3 = fetch(`${base}/api/g/${g}/answers?wait=30`).catch((e) => e);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${base}/api/g/${g}/answers?wait=1`)).status, 429);
  assert.equal((await fetch(`${base}/api/s/${s.id}?after=1&wait=1`)).status, 429);
  await close();
  await Promise.all([w1, w2, w3]);
});

test("the create rate limit is shared between legacy grills and sessions per IP", async (ctx) => {
  const { base, close } = await start({ createsPerHour: 3 });
  ctx.after(close);
  const mkLegacy = () => fetch(`${base}/api/g`, { method: "POST", headers: json({ "x-real-ip": "10.1.1.1" }), body: JSON.stringify({ id: newId(), ct: b64bytes(20), iv: b64bytes(12), writeHash: b64bytes(32) }) });
  const mkSession = async () => {
    const id = newId(), secret = newSecret();
    const sealed = await sealRound(demoGrill(), { id, secret, round: 1 });
    return fetch(`${base}/api/s`, { method: "POST", headers: json({ "x-real-ip": "10.1.1.1" }), body: JSON.stringify({ id, round: 1, operationId: newId(), ct: sealed.ct, iv: sealed.iv, writeHash: sealed.writeHash }) });
  };
  assert.equal((await mkLegacy()).status, 201);
  assert.equal((await mkSession()).status, 201);
  assert.equal((await mkLegacy()).status, 201);
  assert.equal((await mkSession()).status, 429); // 4th create over the shared cap
  assert.equal((await mkLegacy()).status, 429);
  await close();
});

test("a full two-round interview end to end with metrics and no history", async (ctx) => {
  const { base, close } = await start({ statsToken: STATS_TOKEN });
  ctx.after(close);
  const grill = demoGrill();
  const s = await createSession(base, { grill });
  // round 1
  const a1 = await answerRound(base, s, 1, 1, skips(grill));
  assert.equal(a1.res.status, 204);
  const got1 = await (await fetch(`${base}/api/s/${s.id}/rounds/1/answers`)).json();
  assert.deepEqual(await openRoundAnswers({ ct: got1.ct, iv: got1.iv }, grill, s.ids), skips(grill));
  assert.equal((await ackRound(base, s, 1, 2, a1.submissionId)).status, 204);
  // round 2 with a different grill shape, same session identity
  const grill2 = { ...grill, title: "Round two" };
  const sealed2 = await sealRound(grill2, { id: s.id, secret: s.secret, round: 2 });
  const pub2 = await fetch(`${base}/api/s/${s.id}/rounds`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ round: 2, expectedRevision: 3, operationId: newId(), ct: sealed2.ct, iv: sealed2.iv }),
  });
  assert.equal(pub2.status, 201);
  const snap = await getSnapshot(base, s.id);
  assert.equal(snap.body.ct, sealed2.ct); // current round only: round 1 ciphertext is gone
  assert.equal(snap.body.round, 2);
  // identical round-1 answers replay after the advance → 409
  const oldRetry = await fetch(`${base}/api/s/${s.id}/rounds/1/answers`, {
    method: "POST", headers: json(bearer(s.keys)),
    body: JSON.stringify({ expectedRevision: 1, submissionId: a1.submissionId, ct: a1.blob.ct, iv: a1.blob.iv }),
  });
  assert.equal(oldRetry.status, 409);
  // round 2 lifecycle
  const a2 = await answerRound(base, s, 2, 4, skips(grill2));
  assert.equal(a2.res.status, 204);
  const got2 = await (await fetch(`${base}/api/s/${s.id}/rounds/2/answers`)).json();
  assert.deepEqual(await openRoundAnswers({ ct: got2.ct, iv: got2.iv }, grill2, { id: s.id, secret: s.secret, round: 2 }), skips(grill2));
  assert.equal((await ackRound(base, s, 2, 5, a2.submissionId)).status, 204);
  assert.equal((await fetch(`${base}/api/s/${s.id}/finish`, { method: "POST", headers: json(bearer(s.keys)), body: JSON.stringify({ expectedRevision: 6 }) })).status, 204);
  assert.equal((await getSnapshot(base, s.id)).status, 404);
  const counts = await statsCounts(base);
  assert.equal(counts["session_created"], 1);
  assert.equal(counts["session_answered"], 2);
  assert.equal(counts["session_finished"], 1);
  await close();
});

test("concurrent exact ACKs transition once; publish and finish cannot both win", async ctx => {
  const { base, close } = await start(); ctx.after(close);
  const s = await createSession(base), a = await answerRound(base, s, 1, 1, skips(s.grill));
  const replies = await Promise.all(Array.from({ length: 12 }, () => ackRound(base, s, 1, 2, a.submissionId)));
  assert.ok(replies.every(r => r.status === 204));
  assert.equal((await getSnapshot(base, s.id)).body.revision, 3);
  const sealed = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 2 });
  const [pub, finish] = await Promise.all([
    fetch(`${base}/api/s/${s.id}/rounds`, { method: "POST", headers: json(bearer(s.keys)), body: JSON.stringify({ round: 2, expectedRevision: 3, operationId: newId(), ct: sealed.ct, iv: sealed.iv }) }),
    fetch(`${base}/api/s/${s.id}/finish`, { method: "POST", headers: json(bearer(s.keys)), body: JSON.stringify({ expectedRevision: 3 }) }),
  ]);
  assert.equal(Number(pub.status === 201) + Number(finish.status === 204), 1);
  assert.ok(pub.status === 201 ? finish.status === 409 : pub.status === 404);
  const current = await getSnapshot(base, s.id);
  if (pub.status === 201) {
    assert.deepEqual([current.body.round, current.body.revision, current.body.state], [2, 4, "pending"]);
    assert.equal((await ackRound(base, s, 1, 2, a.submissionId)).status, 204);
    assert.deepEqual(await getSnapshot(base, s.id), current);
  } else assert.equal(current.status, 404);
});

test("revision exhaustion refuses transitions instead of exceeding the protocol bound", async ctx => {
  const dir = await mkdtemp(path.join(tmpdir(), "gm-session-max-rev-")), file = path.join(dir, "db.sqlite");
  const { base, close } = await start({ db: file });
  ctx.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const s = await createSession(base), dbh = new DatabaseSync(file);
  try {
    dbh.prepare("UPDATE sessions SET revision = 2147483647 WHERE id = ?").run(s.id);
    assert.equal((await answerRound(base, s, 1, 2147483647, skips(s.grill))).res.status, 409);
    dbh.prepare("UPDATE sessions SET revision = 1 WHERE id = ?").run(s.id);
    const a = await answerRound(base, s, 1, 1, skips(s.grill));
    dbh.prepare("UPDATE sessions SET revision = 2147483647, sub_rev = 2147483646 WHERE id = ?").run(s.id);
    assert.equal((await ackRound(base, s, 1, 2147483647, a.submissionId)).status, 409);
    dbh.prepare("UPDATE sessions SET state = 'idle', ct = NULL, iv = NULL, ans_ct = NULL, ans_iv = NULL WHERE id = ?").run(s.id);
    const sealed = await sealRound(s.grill, { id: s.id, secret: s.secret, round: 2 });
    const pub = await fetch(`${base}/api/s/${s.id}/rounds`, { method: "POST", headers: json(bearer(s.keys)), body: JSON.stringify({ round: 2, expectedRevision: 2147483647, operationId: newId(), ct: sealed.ct, iv: sealed.iv }) });
    assert.equal(pub.status, 409);
    assert.equal((await getSnapshot(base, s.id)).body.revision, 2147483647);
  } finally { dbh.close(); }
});
