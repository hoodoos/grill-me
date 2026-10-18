import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { DEMO_TEXT } from "../../core/src/index.js";
import { send, wait, check } from "../src/index.js";
import { readPending, savePending } from "../src/pending.js";
import { main } from "../src/cli.js";
import { startStdioServer } from "../src/mcp-stdio.js";
import { writeOutput } from "../src/output.js";
import { startFakeServer } from "./fake-server.js";
import { phoneAnswer } from "./phone.js";

const SECRET_ANSWER = "Private answer: preserve this after a lost DELETE reply.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition) => {
  const end = performance.now() + 2000;
  while (!(await condition())) {
    assert.ok(performance.now() < end, "expected asynchronous operation completed");
    await sleep(5);
  }
};
const deletes = (fake) => fake.requests().filter((r) => r.method === "DELETE");

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "grill-me-delivery-"));
  const fake = await startFakeServer();
  t.after(async () => { await fake.close(); await fs.rm(home, { recursive: true, force: true }); });
  const sent = await send(DEMO_TEXT, { home, server: fake.url });
  const pending = await readPending(home, sent.id);
  await phoneAnswer(fake.url, sent.id, pending.secret, [{ n: 1, kind: "own", text: SECRET_ANSWER }]);
  return { home, fake, id: sent.id, pending };
}

async function assertCache(home, id) {
  const bytes = await fs.readFile(path.join(home, "pending", `${id}.json`), "utf8");
  assert.ok(!bytes.includes(SECRET_ANSWER), "no plaintext answers on disk");
  const record = JSON.parse(bytes);
  assert.deepEqual(Object.keys(record.answerBlob).sort(), ["ct", "iv"]);
  assert.equal(typeof record.answerBlob.ct, "string");
  return record;
}

function gateOutput() {
  const writes = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { writes.push({ text: chunk.toString(), callback }); } });
  return { stream, writes };
}

function useHome(t, home, server) {
  const before = { GRILL_ME_HOME: process.env.GRILL_ME_HOME, GRILL_ME_SERVER: process.env.GRILL_ME_SERVER };
  process.env.GRILL_ME_HOME = home;
  process.env.GRILL_ME_SERVER = server;
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("library collects durable ciphertext before explicit ack and never deletes during delivery", async (t) => {
  const { home, fake, id } = await fixture(t);
  const result = await wait(id, { home, seconds: 1 });
  t.after(result.dispose);
  assert.equal(result.status, "ANSWERS");
  assert.match(result.lines, /Private answer/);
  assert.deepEqual((await assertCache(home, id)).answerBlob, fake.grill(id).ans);
  assert.equal(deletes(fake).length, 0);
  assert.equal(result.canDeliver(), true);
  await result.ack(); // the library caller acknowledges only after delivery succeeds
  assert.equal(await readPending(home, id), null);
  assert.equal(fake.grill(id), undefined);
});

test("failed atomic cache persistence prevents delivery and DELETE; concurrent writes use unique temps", async (t) => {
  const { home, fake, id, pending } = await fixture(t);
  const otherTemp = path.join(home, "pending", ".unrelated.tmp");
  await fs.writeFile(otherTemp, "keep");
  const rename = fs.rename.bind(fs);
  const fault = t.mock.method(fs, "rename", async () => { throw new Error("injected cache rename failure"); });
  await assert.rejects(wait(id, { home, seconds: 1 }), /injected cache rename failure/);
  fault.mock.restore();
  assert.equal(deletes(fake).length, 0);
  assert.equal((await readPending(home, id)).answerBlob, undefined);
  assert.equal(await fs.readFile(otherTemp, "utf8"), "keep");
  assert.deepEqual((await fs.readdir(path.join(home, "pending"))).sort(), [".unrelated.tmp", `${id}.json`].sort());
  const sources = [];
  t.mock.method(fs, "rename", async (from, to) => { sources.push(from); return rename(from, to); });
  await Promise.all(Array.from({ length: 12 }, () => savePending(home, { ...pending, answerBlob: fake.grill(id).ans })));
  assert.equal(new Set(sources).size, 12, "each concurrent write owns a separate temp path");
  await assertCache(home, id);
  assert.deepEqual((await fs.readdir(path.join(home, "pending"))).sort(), [".unrelated.tmp", `${id}.json`].sort());
});

test("cancellation after fetch/cache and before delivery retains ciphertext for replay", async (t) => {
  const { home, fake, id } = await fixture(t);
  const ctrl = new AbortController();
  const rename = fs.rename.bind(fs);
  const fault = t.mock.method(fs, "rename", async (...args) => { await rename(...args); ctrl.abort(); });
  await assert.rejects(wait(id, { home, seconds: 1, signal: ctrl.signal }), { code: "aborted" });
  fault.mock.restore();
  await assertCache(home, id);
  assert.equal(deletes(fake).length, 0);
  const recovered = await check(id, { home });
  assert.match(recovered.lines, /Private answer/);
  await recovered.ack();
});

test("deadline before delivery returns WAITING while retaining the fetched cache", async (t) => {
  const { home, fake, id } = await fixture(t);
  let clock = Date.now();
  const rename = fs.rename.bind(fs);
  const fault = t.mock.method(fs, "rename", async (...args) => { await rename(...args); clock += 2000; });
  const result = await wait(id, { home, seconds: 1, now: () => clock });
  fault.mock.restore();
  assert.equal(result.status, "WAITING");
  await assertCache(home, id);
  assert.equal(deletes(fake).length, 0);
});

test("cancellation/deadline between collection and ack does not DELETE cached answers", async (t) => {
  const { home, fake, id } = await fixture(t);
  const ctrl = new AbortController();
  const result = await check(id, { home, signal: ctrl.signal });
  ctrl.abort();
  assert.throws(result.canDeliver, { code: "aborted" });
  await assert.rejects(result.ack(), { code: "aborted" });
  assert.equal(deletes(fake).length, 0);
  await assertCache(home, id);
  const expired = await wait(id, { home, seconds: 0.08 });
  await sleep(100);
  assert.equal(expired.canDeliver(), false);
  await assert.rejects(expired.ack(), { code: "deadline" });
  assert.equal(deletes(fake).length, 0);
  await assertCache(home, id);
});

for (const mode of ["stalled headers", "slow reply", "committed lost reply", "committed cancellation", "503"]) {
  test(`ack handles DELETE ${mode} without answer loss, then replays cache before any GET`, async (t) => {
    const { home, fake, id } = await fixture(t);
    const ctrl = new AbortController();
    const result = await wait(id, { home, seconds: 0.2, signal: ctrl.signal });
    if (mode === "stalled headers") fake.intercept((req) => req.method === "DELETE");
    else if (mode === "503") fake.intercept((req, res) => {
      if (req.method !== "DELETE") return false;
      res.writeHead(503).end(); return true;
    });
    else fake.afterDelete((_req, res) => {
      if (mode === "slow reply") setTimeout(() => res.writeHead(204).end(), 350);
      if (mode === "committed cancellation") ctrl.abort();
      return true;
    });
    const start = performance.now();
    await assert.rejects(result.ack());
    assert.ok(performance.now() - start < 900, "cleanup uses the original short deadline");
    await assertCache(home, id);
    if (mode.startsWith("committed") || mode === "slow reply") assert.equal(fake.grill(id), undefined);
    fake.intercept(() => false);
    fake.afterDelete(() => false);
    const before = fake.requests().length;
    const recovered = await check(id, { home });
    assert.match(recovered.lines, /Private answer/);
    assert.equal(fake.requests().length, before, "cache replay precedes the server, even after DELETE committed");
    await recovered.ack(); // 404 after an ambiguous committed DELETE is a successful acknowledgement
    assert.equal(await readPending(home, id), null);
  });
}

test("unbounded library/CLI cleanup still retries transient network failure", async (t) => {
  const { home, fake, id } = await fixture(t);
  let attempts = 0;
  fake.intercept((req, res) => {
    if (req.method !== "DELETE" || attempts++ > 0) return false;
    res.destroy(); return true;
  });
  const result = await wait(id, { home });
  await result.ack();
  assert.equal(attempts, 2);
  assert.equal(await readPending(home, id), null);
});

test("cancellation racing pending unlink restores ciphertext after confirmed DELETE", async (t) => {
  const { home, fake, id } = await fixture(t);
  const ctrl = new AbortController();
  const result = await wait(id, { home, seconds: 1, signal: ctrl.signal });
  const remove = fs.rm.bind(fs);
  const target = path.join(home, "pending", `${id}.json`);
  const fault = t.mock.method(fs, "rm", async (file, options) => {
    await remove(file, options);
    if (file === target) ctrl.abort();
  });
  await assert.rejects(result.ack(), { code: "aborted" });
  fault.mock.restore();
  assert.equal(fake.grill(id), undefined);
  await assertCache(home, id);
  const recovered = await check(id, { home });
  assert.match(recovered.lines, /Private answer/);
  await recovered.ack();
  assert.equal(await readPending(home, id), null);
});

for (const failed of [false, true]) {
  test(`CLI stdout callback ${failed ? "failure keeps cache and never DELETEs" : "success precedes DELETE"}`, async (t) => {
    const { home, fake, id } = await fixture(t);
    useHome(t, home, fake.url);
    const output = gateOutput();
    const running = main(["fetch", id], { stdin: new PassThrough(), stdout: output.stream, stderr: new PassThrough() });
    await until(() => output.writes.length === 1);
    assert.match(output.writes[0].text, /Private answer:[\s\S]*STATUS: ANSWERS\n$/);
    await assertCache(home, id);
    assert.equal(deletes(fake).length, 0, "no DELETE while stdout callback is pending");
    output.writes[0].callback(failed ? new Error("injected stdout failure") : null);
    assert.equal(await running, failed ? 1 : 0);
    if (failed) {
      assert.equal(deletes(fake).length, 0);
      await assertCache(home, id);
      const recovered = await check(id, { home });
      await recovered.ack();
    } else assert.equal(await readPending(home, id), null);
  });
}

for (const action of ["deliver", "fail", "cancel", "stdin end"]) {
  test(`MCP output ${action}: cached before callback, cleanup only after successful delivery`, async (t) => {
    const { home, fake, id } = await fixture(t);
    useHome(t, home, fake.url);
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    let diagnostics = "";
    stderr.on("data", (chunk) => diagnostics += chunk);
    const output = gateOutput();
    const running = startStdioServer({ stdin, stdout: output.stream, stderr, env: { GRILL_ME_WAIT_SECONDS: "1" } });
    t.after(async () => { stdin.end(); await running; });
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "grill_wait", arguments: { id } } }) + "\n");
    await until(() => output.writes.length === 1);
    const reply = JSON.parse(output.writes[0].text);
    assert.equal(reply.result.structuredContent.status, "ANSWERS");
    assert.equal(Object.keys(reply.result.structuredContent).sort().join(","), "answers,status");
    await assertCache(home, id);
    assert.equal(deletes(fake).length, 0);
    if (action === "cancel") stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }) + "\n");
    else if (action === "stdin end") stdin.end();
    else output.writes[0].callback(action === "fail" ? new Error("injected stdout failure") : null);
    if (action === "deliver") await until(async () => (await readPending(home, id)) === null);
    else {
      await until(() => diagnostics.includes("output interrupted"));
      if (action === "cancel" || action === "stdin end") output.writes[0].callback();
      await assertCache(home, id);
      assert.equal(deletes(fake).length, 0, "failed/cancelled output never acknowledges");
      const recovered = await check(id, { home });
      await recovered.ack();
    }
  });
}

test("aborted writes remove their error listener when a late success callback arrives", async () => {
  const output = gateOutput();
  const baseline = output.stream.listenerCount("error");
  for (let i = 0; i < 15; i++) {
    const ctrl = new AbortController();
    const writing = writeOutput(output.stream, "answer\n", ctrl.signal);
    ctrl.abort();
    await assert.rejects(writing, /output interrupted/);
    output.writes[i].callback();
    assert.equal(output.stream.listenerCount("error"), baseline);
  }
});
