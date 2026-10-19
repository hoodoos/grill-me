import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { parseSessionLink, sealRoundAnswers } from "../../core/src/session.js";
import { newId } from "../../core/src/crypto.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const grill = { v: 1, questions: [{ n: 1, title: "Disposable handoff", recommend: { why: "Test the current frontier" } }] };
async function fixture(t) {
  const srv = createServer({ db: ":memory:", log: () => {} });
  await new Promise(resolve => srv.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { srv.server.closeAllConnections(); await srv.close(); });
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  let id = 0;
  const rpc = async (method, params = {}) => {
    const response = await fetch(base + "/mcp", { method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    return JSON.parse(raw.startsWith(":") ? raw.split("\n").find(line => line.startsWith("data: ")).slice(6) : raw).result;
  };
  const call = async (name, args = {}) => {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text); return result;
  };
  return { rpc, call };
}

test("actual hosted text and structured results separate inline yield from phone waits", async t => {
  const { rpc, call } = await fixture(t);
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "workflow fixture", version: "1" } });
  const prepared = await call("grill_start"), { link } = prepared.structuredContent;
  const ready = await call("grill_send", { link, round: 1, expectedRevision: 0, grill });
  const shown = await call("grill_show", { link });
  assert.equal(shown.structuredContent.nextAction, "YIELD_FOR_INLINE_INPUT");
  assert.match(shown.content[0].text, /YIELD_FOR_INLINE_INPUT/);
  for (const text of [init.instructions, prepared.content[0].text, ready.content[0].text, shown.content[0].text]) {
    assert.match(text, /end your turn/);
    assert.match(text, /do not call grill_wait/);
  }
  assert.match(ready.content[0].text, /successfully registered subscription/);
  const tools = (await rpc("tools/list")).tools;
  assert.match(tools.find(tool => tool.name === "grill_wait").description, /seconds:1/);
  assert.match(tools.find(tool => tool.name === "grill_show").description, /end your turn/);
  const waiting = await call("grill_wait", { link, round: 1, seconds: 1 });
  assert.equal(waiting.structuredContent.status, "WAITING");
  assert.match(waiting.content[0].text, /INLINE/);
  assert.match(waiting.content[0].text, /PHONE/);
  await call("grill_cancel", { link });
});

test("controlled host queues accepted UI follow-up while busy; yielding permits real read-retain-ACK and next round", async t => {
  const { call } = await fixture(t);
  const { link } = (await call("grill_start")).structuredContent;
  await call("grill_send", { link, round: 1, expectedRevision: 0, grill });
  const shown = await call("grill_show", { link });
  const ids = parseSessionLink(link);
  let activeTurn = true, queued, retained, next;
  // A controlled scheduler, NOT a claim about any provider's actual queue policy.
  const hostMessage = continuation => { queued = continuation; return { isError: false }; };
  const releaseTurn = async () => { activeTurn = false; if (queued) { const run = queued; queued = null; await run(); } };
  const submitted = await call("grill_ui_submit", { link, round: 1, expectedRevision: 1, submissionId: newId(),
    ...await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }] }, grill, { ...ids, round: 1 }) });
  assert.equal(submitted.structuredContent.status, "SUBMITTED");
  assert.equal(hostMessage(async () => {
    retained = (await call("grill_wait", { link, round: 1, seconds: 1 })).structuredContent;
    assert.equal(retained.status, "ANSWERS"); assert.match(retained.answers, /Q1 - agree/);
    const ack = (await call("grill_ack", { link, receipt: retained.receipt })).structuredContent;
    next = await call("grill_send", { link, round: 2, expectedRevision: ack.revision, grill });
  }).isError, false);
  // Negative control: acceptance alone cannot run a queued turn or acknowledge data.
  assert.equal(activeTurn, true); assert.equal(retained, undefined);
  assert.equal((await call("grill_ui_state", { link })).structuredContent.snapshot.state, "answered");
  assert.equal(shown.structuredContent.nextAction, "YIELD_FOR_INLINE_INPUT");
  await releaseTurn();
  assert.equal(activeTurn, false); assert.equal(next.structuredContent.round, 2);
  assert.match(next.content[0].text, /If the inline view is already open/);
  assert.match(next.content[0].text, /end your turn/);
  assert.ok(!next.content[0].text.includes("call grill_show ONCE"));
  const snapshot = (await call("grill_ui_state", { link })).structuredContent.snapshot;
  assert.equal(snapshot.round, 2); assert.equal(snapshot.state, "pending");
  await call("grill_cancel", { link });
});

test("hosted presentation branches keep inline questions in cards and phone-only full frontier, with unchanged original skill and ACK ordering", async t => {
  const { rpc, call } = await fixture(t);
  const original = await readFile(new URL("../../core/src/grilling.md", import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(original).digest("hex"), "befdff1e27a1dfe2a294d5871169ac1afe16d983911daa4f32627514a48c1e15");
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "presentation fixture", version: "1" } });
  const start = await call("grill_start"), { link } = start.structuredContent;
  for (const text of [init.instructions, start.content[0].text, start.structuredContent.grillingInstructions]) {
    assert.equal(text.split(original).length, 2, "complete original body delivered once, unchanged");
    assert.ok(text.indexOf("TRANSPORT PRESENTATION OVERRIDE") > text.indexOf(original) + original.length);
    assert.match(text, /INLINE means the interactive cards actually render/);
    assert.match(text, /sole user-facing chat copy.*Grill it on your phone: <same link>/);
    assert.match(text, /PHONE-ONLY.*show the full frontier/);
    assert.doesNotMatch(text.replace(original, ""), /Show ALL questions|Show the complete questions/);
  }
  const catalog = (await rpc("tools/list")).tools;
  for (const name of ["grill_start", "grill_send", "grill_show", "grill_wait", "grill_ack"]) {
    const description = catalog.find(tool => tool.name === name).description;
    assert.match(description, /INLINE/); assert.match(description, /PHONE/);
    assert.doesNotMatch(description, /Show ALL questions/);
  }
  const frontier = { v: 1, questions: [{ n: 1, title: "PRIVATE_FRONTIER_TITLE", body: "PRIVATE_FRONTIER_BODY", recommend: { why: "PRIVATE_FRONTIER_RECOMMENDATION" } }] };
  const ready = await call("grill_send", { link, round: 1, expectedRevision: 0, grill: frontier });
  const shown = await call("grill_show", { link });
  for (const text of [ready.content[0].text, shown.content[0].text, shown.structuredContent.message]) {
    assert.match(text, /INLINE:.*(?:ONLY in cards|print only)/);
    assert.match(text, /PHONE-ONLY.*full frontier/);
    assert.doesNotMatch(text, /PRIVATE_FRONTIER_/);
  }
  assert.ok(ready.content[0].text.includes("Grill it on your phone: " + link));
  assert.equal(shown.structuredContent.nextAction, "YIELD_FOR_INLINE_INPUT");
  const waiting = await call("grill_wait", { link, round: 1, seconds: 1 });
  assert.match(waiting.structuredContent.message, /INLINE:.*only 'Grill it on your phone:/);
  assert.match(waiting.content[0].text, /PHONE-ONLY:.*full frontier/);
  assert.equal((await call("grill_ui_state", { link })).structuredContent.snapshot.state, "pending", "waiting never ACKs or replaces frontier");
  const ids = parseSessionLink(link);
  await call("grill_ui_submit", { link, round: 1, expectedRevision: 1, submissionId: newId(),
    ...await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }] }, frontier, { ...ids, round: 1 }) });
  const answers = (await call("grill_wait", { link, round: 1, seconds: 1 })).structuredContent;
  assert.equal(answers.status, "ANSWERS"); assert.equal(answers.answers, "Q1 - agree");
  assert.match(answers.message, /INLINE: do not echo/);
  assert.equal((await call("grill_ui_state", { link })).structuredContent.snapshot.state, "answered");
  const ack = (await call("grill_ack", { link, receipt: answers.receipt })).structuredContent;
  assert.match(ack.next, /INLINE:.*chat ONLY Grill it on your phone:/);
  assert.match(ack.next, /PHONE-ONLY: show the full formatted frontier/);
  const next = await call("grill_send", { link, round: 2, expectedRevision: ack.revision, grill: frontier });
  assert.match(next.content[0].text, /If the inline view is already open.*end your turn/);
  assert.doesNotMatch(next.content[0].text, /PRIVATE_FRONTIER_|Show the complete questions/);
  await call("grill_cancel", { link });
});
