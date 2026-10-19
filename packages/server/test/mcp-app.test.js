import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { parseSessionLink, sealRoundAnswers } from "../../core/src/session.js";
import { newId, newSecret } from "../../core/src/crypto.js";
import { readFile } from "node:fs/promises";
const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const grill = { v: 1, questions: [{ n: 1, title: "Inline disposable", recommend: { why: "Test" } }] };
const parse = text => JSON.parse(text.startsWith(":") ? text.split("\n").find(l => l.startsWith("data: ")).slice(6) : text);
export async function fixture(t) {
  const srv = createServer({ db: ":memory:", log: () => {} });
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  t.after(async () => { srv.server.closeAllConnections(); await srv.close(); });
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  let seq = 0;
  const rpc = async (method, params = {}, modern = false) => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
    const response = await fetch(base + "/mcp", { method: "POST", headers: { ...headers, ...(modern ? { "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      ...(["tools/call", "resources/read"].includes(method) ? { "mcp-name": params.name ?? params.uri } : {}) } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params: { ...params, ...(modern ? { _meta: meta } : {}) } }) });
    return { status: response.status, body: parse(await response.text()) };
  };
  const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).body.result;
  return { srv, base, rpc, call };
}
test("stateless Apps catalog has explicit least privilege; immutable self-contained resource and modern envelopes", async t => {
  const f = await fixture(t);
  const catalog = (await f.rpc("tools/list")).body.result.tools;
  for (const tool of catalog) assert.deepEqual(tool._meta.ui.visibility, tool.name.startsWith("grill_ui_") ? ["app"] : ["model"]);
  const show = catalog.find(x => x.name === "grill_show"); assert.equal(show.annotations.readOnlyHint, true);
  for (const modern of [false, true]) {
    const list = (await f.rpc("resources/list", {}, modern)).body.result;
    const uri = list.resources[0].uri; assert.equal(uri, show._meta.ui.resourceUri); assert.match(uri, /^ui:\/\/grill-me\/interview-[a-f0-9]+\.html$/);
    const result = (await f.rpc("resources/read", { uri }, modern)).body.result;
    if (modern) for (const key of ["cacheScope", "ttlMs", "resultType"]) assert.ok(Object.hasOwn(result, key));
    const resource = result.contents[0]; assert.equal(resource.mimeType, "text/html;profile=mcp-app");
    assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [] });
    assert.ok(resource.text.includes("<script>")); assert.ok(!/<(?:script|iframe)[^>]+src=/.test(resource.text));
    const notices = JSON.parse(resource.text.match(/id="third-party-notices">(.*?)<\/script>/s)[1]);
    assert.ok(notices.some(n => n.package === "@modelcontextprotocol/ext-apps"));
    for (const pkg of notices) for (const file of pkg.notices) {
      assert.equal(file.text, await readFile(new URL(`../../../node_modules/${pkg.package}/${file.name}`, import.meta.url), "utf8"), "actual bundled license bytes retained");
    }
    assert.equal((await f.rpc("resources/read", { uri: "https://private-sentinel.invalid" }, modern)).body.error.message, "Unknown resource");
  }
  const init = (await f.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } })).body.result;
  assert.ok(init.capabilities.resources); assert.equal(init.protocolVersion, "2025-11-25");
  assert.ok((await f.rpc("server/discover", {}, true)).body.result.capabilities.resources);
});
test("private view context only in result metadata, UI encrypted submit exact retries/conflict and explicit agent ACK", async t => {
  const f = await fixture(t), prepared = (await f.call("grill_start")).structuredContent;
  const { link } = prepared, ids = parseSessionLink(link);
  await f.call("grill_send", { link, round: 1, expectedRevision: 0, grill });
  const shown = await f.call("grill_show", { link });
  assert.equal(shown._meta["ai.grill-me/view"].link, link);
  assert.ok(!JSON.stringify(shown.content).includes(ids.secret)); assert.ok(!JSON.stringify(shown.structuredContent).includes(ids.secret));
  const badLink = link.replace(ids.secret, newSecret());
  assert.equal((await f.call("grill_ui_state", { link: badLink })).isError, true);
  const state = (await f.call("grill_ui_state", { link })).structuredContent;
  assert.equal(state.snapshot.state, "pending"); assert.ok(state.snapshot.ct); assert.ok(!JSON.stringify(state).includes(grill.questions[0].title));
  const waiting = f.call("grill_ui_state", { link, afterRevision: 1, seconds: 1 });
  const body = { link, round: 1, expectedRevision: 1, submissionId: newId(), ...await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }] }, grill, { ...ids, round: 1 }) };
  assert.equal((await f.call("grill_ui_submit", body)).structuredContent.status, "SUBMITTED");
  assert.equal((await waiting).structuredContent.snapshot.state, "answered");
  assert.equal((await f.call("grill_ui_submit", body)).structuredContent.status, "SUBMITTED");
  assert.equal((await f.call("grill_ui_submit", { ...body, submissionId: newId() })).structuredContent.status, "CONFLICT");
  const answers = (await f.call("grill_wait", { link, round: 1, seconds: 1 })).structuredContent;
  assert.equal(answers.status, "ANSWERS");
  assert.equal((await f.call("grill_ui_state", { link })).structuredContent.snapshot.state, "answered", "render/submit/follow-up never ACK");
  await f.call("grill_ack", { link, receipt: answers.receipt });
  const acked = (await f.call("grill_ui_state", { link })).structuredContent.snapshot;
  assert.equal(acked.state, "idle"); assert.equal(acked.ct, undefined);
  await f.call("grill_send", { link, round: 2, expectedRevision: acked.revision, grill });
  assert.equal((await f.call("grill_ui_submit", body)).structuredContent.status, "CONFLICT");
  await f.call("grill_cancel", { link });
  assert.equal((await f.call("grill_ui_state", { link })).structuredContent.reason, "cancelled");
});
