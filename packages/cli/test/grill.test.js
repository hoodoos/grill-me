import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEMO_TEXT, contentHash } from "../../core/src/index.js";
import { send, wait, fetch as fetchGrill, resend, cancel } from "../src/index.js";
import { readPending, savePending, prunePending } from "../src/pending.js";
import { startFakeServer } from "./fake-server.js";
import { phoneAnswer } from "./phone.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "grill-me-test-"));
  const fake = await startFakeServer();
  t.after(async () => {
    await fake.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, server: fake.url, fake };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PICKS = [
  { n: 1, kind: "agree" },
  { n: 2, kind: "choice", choice: "Always dark" },
  { n: 3, kind: "own", text: "Keep them for a week." },
  { n: 4, kind: "skip" },
];
const EXPECTED_LINES = "Q1 - agree\nQ2 - Always dark\nQ3 - Keep them for a week.\nQ4 - skip for now, ask again later";

test("send → pending file → phone answers → wait returns ANSWERS and cleans up", async (t) => {
  const { home, server, fake } = await fixture(t);
  const r = await send(DEMO_TEXT, { server, home });
  assert.equal(r.count, 4);
  assert.match(r.link, new RegExp(`^${server}/g/[A-Za-z0-9_-]{16}#[A-Za-z0-9_-]{22}$`));
  assert.ok(r.qr.length > 0);

  const pending = await readPending(home, r.id);
  assert.equal(pending.id, r.id);
  assert.equal(pending.server, server);
  assert.equal(pending.grill.questions.length, 4);
  if (process.platform !== "win32") {
    const mode = (await fs.stat(path.join(home, "pending", `${r.id}.json`))).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  const answering = sleep(150).then(() => phoneAnswer(server, r.id, pending.secret, PICKS));
  const result = await wait(r.id, { home });
  assert.equal(result.status, "ANSWERS");
  assert.equal(result.lines, EXPECTED_LINES);
  await answering;

  assert.equal(await readPending(home, r.id), null, "pending file removed");
  assert.equal(fake.grill(r.id), undefined, "grill DELETEd");
});

test("send retries with a new id on 409", async (t) => {
  const { home, server, fake } = await fixture(t);
  fake.conflictNext(1);
  const r = await send(DEMO_TEXT, { server, home });
  assert.equal(fake.creates(), 2);
  assert.ok((await readPending(home, r.id)) !== null);
});

test("wait → EXPIRED keeps the pending file for resend", async (t) => {
  const { home, server, fake } = await fixture(t);
  const r = await send(DEMO_TEXT, { server, home });
  fake.expire(r.id);
  const result = await wait(r.id, { home });
  assert.equal(result.status, "EXPIRED");
  assert.ok((await readPending(home, r.id)) !== null, "pending file kept");
});

test("wait → OFFLINE after the failure window, pending file kept", async (t) => {
  const { home, server, fake } = await fixture(t);
  const r = await send(DEMO_TEXT, { server, home });
  fake.failNext(1000);
  const retries = [];
  const result = await wait(r.id, {
    home,
    pollSeconds: 0,
    offlineMs: 50,
    backoffMs: () => 2,
    onRetry: (info) => retries.push(info),
  });
  assert.equal(result.status, "OFFLINE");
  assert.ok(retries.length >= 2, "retried quietly before giving up");
  assert.ok((await readPending(home, r.id)) !== null, "pending file kept");
});

test("transient failures are retried quietly, then ANSWERS", async (t) => {
  const { home, server, fake } = await fixture(t);
  const r = await send(DEMO_TEXT, { server, home });
  const pending = await readPending(home, r.id);
  fake.failNext(3);
  const retries = [];
  const answering = sleep(200).then(() => phoneAnswer(server, r.id, pending.secret, PICKS));
  const result = await wait(r.id, { home, backoffMs: () => 10, onRetry: (info) => retries.push(info) });
  assert.equal(result.status, "ANSWERS");
  assert.equal(result.lines, EXPECTED_LINES);
  assert.equal(retries.length, 3);
  assert.deepEqual(retries.map((x) => x.error.code), ["server", "server", "server"]);
  await answering;
});

test("wait honours the seconds budget → WAITING", async (t) => {
  const { home, server } = await fixture(t);
  const r = await send(DEMO_TEXT, { server, home });
  const result = await wait(r.id, { home, seconds: 0.05, pollSeconds: 0 });
  assert.equal(result.status, "WAITING");
  assert.ok((await readPending(home, r.id)) !== null);
});

test("fetch → WAITING, then ANSWERS once the phone has answered", async (t) => {
  const { home, server, fake } = await fixture(t);
  const r = await send(DEMO_TEXT, { server, home });
  const pending = await readPending(home, r.id);

  const first = await fetchGrill(r.id, { home });
  assert.equal(first.status, "WAITING");
  assert.ok((await readPending(home, r.id)) !== null, "pending kept while waiting");

  await phoneAnswer(server, r.id, pending.secret, PICKS);
  const second = await fetchGrill(r.id, { home });
  assert.equal(second.status, "ANSWERS");
  assert.equal(second.lines, EXPECTED_LINES);
  assert.equal(fake.grill(r.id), undefined);
  assert.equal(await readPending(home, r.id), null);
});

test("fetch → EXPIRED", async (t) => {
  const { home, server, fake } = await fixture(t);
  const r = await send(DEMO_TEXT, { server, home });
  fake.expire(r.id);
  assert.equal((await fetchGrill(r.id, { home })).status, "EXPIRED");
});

test("resend: new id and new secret, same contentHash, old pending removed, old grill deleted", async (t) => {
  const { home, server, fake } = await fixture(t);
  const r1 = await send(DEMO_TEXT, { server, home });
  const before = await readPending(home, r1.id);

  const r2 = await resend(r1.id, { home });
  assert.notEqual(r2.id, r1.id);
  const after = await readPending(home, r2.id);
  assert.notEqual(after.secret, before.secret);
  assert.equal(await contentHash(after.grill), await contentHash(before.grill));
  assert.equal(await readPending(home, r1.id), null, "old pending removed");
  assert.equal(fake.grill(r1.id), undefined, "old grill deleted");

  // the re-sent grill works end to end
  const answering = sleep(150).then(() => phoneAnswer(server, r2.id, after.secret, PICKS));
  assert.equal((await wait(r2.id, { home })).status, "ANSWERS");
  await answering;
});

test("cancel: DELETEs and removes the pending file; 404 counts as success", async (t) => {
  const { home, server, fake } = await fixture(t);
  const r = await send(DEMO_TEXT, { server, home });
  assert.deepEqual(await cancel(r.id, { home }), { status: "CANCELLED" });
  assert.equal(fake.grill(r.id), undefined);
  assert.equal(await readPending(home, r.id), null);

  const r2 = await send(DEMO_TEXT, { server, home });
  fake.expire(r2.id);
  assert.deepEqual(await cancel(r2.id, { home }), { status: "CANCELLED" });
  assert.equal(await readPending(home, r2.id), null);
});

test("an unknown id says the grill came from another machine or was already fetched", async (t) => {
  const { home } = await fixture(t);
  for (const op of [wait, fetchGrill, resend, cancel]) {
    await assert.rejects(() => op("Abcd1234_efgh-ij", { home }), {
      code: "unknown-id",
      message: /another machine|already fetched/,
    });
  }
});

test("prunePending removes files older than 3 days", async (t) => {
  const { home } = await fixture(t);
  const grill = { v: 1, questions: [{ n: 1, title: "T", body: "", choices: [], recommend: null, multi: false }] };
  const old = { v: 1, id: "Abcd1234_efgh-ij", secret: "x".repeat(22), server: "s", grill, createdAt: new Date(Date.now() - 4 * 86400_000).toISOString() };
  const fresh = { ...old, id: "Zbcd1234_efgh-ij", createdAt: new Date().toISOString() };
  await savePending(home, old);
  await savePending(home, fresh);
  assert.equal(await prunePending(home), 1);
  assert.equal(await readPending(home, old.id), null);
  assert.ok((await readPending(home, fresh.id)) !== null);
});

test("bad input throws core's message plus the schema", async (t) => {
  const { home, server } = await fixture(t);
  await assert.rejects(() => send("just a paragraph, no questions in it", { server, home }), (err) => {
    assert.equal(err.code, "input");
    assert.match(err.message, /no questions found/);
    assert.equal(err.schema.type, "object");
    assert.ok(err.schema.properties.questions);
    return true;
  });
});

test("every command prunes stale pending files", async (t) => {
  const { home, server } = await fixture(t);
  const stale = {
    v: 1,
    id: "Cbcd1234_efgh-ij",
    secret: "x".repeat(22),
    server,
    grill: { v: 1, questions: [{ n: 1, title: "T", body: "", choices: [], recommend: null, multi: false }] },
    createdAt: new Date(Date.now() - 4 * 86400_000).toISOString(),
  };
  await savePending(home, stale);
  await send(DEMO_TEXT, { server, home });
  assert.equal(await readPending(home, stale.id), null, "send pruned the stale file");
});
