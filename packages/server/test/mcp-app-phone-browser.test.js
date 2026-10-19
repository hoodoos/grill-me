import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildSync } from "esbuild";
import { createServer } from "../src/server.js";
import { parseSessionLink, deriveSessionKeys, sealRoundAnswers } from "../../core/src/session.js";
import { newId } from "../../core/src/crypto.js";

test("official AppBridge forwards phone winner: rejected retry, same-view next round, own-submit dedupe and stale message completion", {
  skip: !process.env.GRILL_ME_APPS_BROWSER, timeout: 30_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || "playwright-core");
  const srv = createServer({ db: ":memory:", log: () => {} });
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  let browser, host, sequence = 0, held, rejectFirst = true;
  const errors = [], messages = [], retained = [], calls = [];
  t.after(async () => { held?.end(JSON.stringify({})); await browser?.close(); host?.closeAllConnections(); if (host?.listening) await new Promise(r => host.close(r)); srv.server.closeAllConnections(); await srv.close(); });
  const rpc = async (method, params = {}) => {
    const res = await fetch(base + "/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }) });
    const raw = await res.text(); return JSON.parse(raw.startsWith(":") ? raw.split("\n").find(l => l.startsWith("data: ")).slice(6) : raw).result;
  };
  const call = async (name, args = {}) => { const result = await rpc("tools/call", { name, arguments: args }); assert.ok(!result.isError); return result; };
  const grill = { v: 1, questions: [{ n: 1, title: "Phone and inline", recommend: { why: "Disposable recommendation" } }] };
  const { link } = (await call("grill_start")).structuredContent, ids = parseSessionLink(link), keys = await deriveSessionKeys(ids.secret);
  await call("grill_send", { link, round: 1, expectedRevision: 0, grill });
  const shown = await call("grill_show", { link }), catalog = (await rpc("tools/list")).tools;
  const resource = (await rpc("resources/read", { uri: catalog.find(x => x.name === "grill_show")._meta.ui.resourceUri })).contents[0].text;
  const collect = async body => {
    const round = Number(/round (\d+),/.exec(body.content[0].text)[1]);
    const answer = (await call("grill_wait", { link, round, seconds: 1 })).structuredContent;
    assert.equal(answer.status, "ANSWERS");
    assert.ok(body.content[0].text.includes(answer.receipt.submissionId), "notification names actual server winner");
    retained.push(answer); // scripted host retains BEFORE exact ACK, never the widget
    const ack = (await call("grill_ack", { link, receipt: answer.receipt })).structuredContent;
    if (round <= 2) await call("grill_send", { link, round: round + 1, expectedRevision: ack.revision, grill });
    else await call("grill_finish", { link, expectedRevision: ack.revision });
  };
  const script = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
    import {AppBridge,PostMessageTransport,isToolVisibilityModelOnly} from '@modelcontextprotocol/ext-apps/app-bridge';
    const frame=document.querySelector('iframe'),catalog=await(await fetch('/catalog')).json();
    const bridge=new AppBridge(null,{name:'Controlled hybrid host',version:'1'},{serverTools:{},message:{text:{}}},
      {hostContext:{containerDimensions:{height:350,width:390},displayMode:'inline'}});
    bridge.oncalltool=async p=>{if(!catalog.some(t=>t.name===p.name&&!isToolVisibilityModelOnly(t)))throw Error('Visibility denied');return(await fetch('/tool',{method:'POST',body:JSON.stringify(p)})).json();};
    bridge.onmessage=async p=>(await fetch('/message',{method:'POST',body:JSON.stringify(p)})).json();
    bridge.oninitialized=async()=>{await bridge.sendToolResult(await(await fetch('/shown')).json());window.ready=true;};
    window.bridge=bridge;await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/view';
  ` }, bundle: true, write: false, format: "esm", platform: "browser" }).outputFiles[0].text;
  host = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      res.setHeader("cache-control", "no-store");
      if (req.url === "/") { res.setHeader("content-type", "text/html"); return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{border:0;width:390px;height:350px}</style><iframe sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script>'); }
      if (req.url === "/host.js") { res.setHeader("content-type", "text/javascript"); return res.end(script); }
      if (req.url === "/view") { res.setHeader("content-type", "text/html"); res.setHeader("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"); return res.end(resource); }
      res.setHeader("content-type", "application/json");
      if (req.url === "/catalog") return res.end(JSON.stringify(catalog));
      if (req.url === "/shown") return res.end(JSON.stringify(shown));
      if (req.url === "/tool") { calls.push(body); return res.end(JSON.stringify(await rpc("tools/call", body))); }
      if (req.url === "/message") {
        messages.push(body);
        if (rejectFirst) { rejectFirst = false; return res.end(JSON.stringify({ isError: true })); }
        const round = Number(/round (\d+),/.exec(body.content[0].text)[1]);
        // Hold round1's accepted response until round2's OWN notice arrives. Neither
        // state polling nor the next notice may wait for this earlier host response.
        if (round === 1) held = res;
        else { held?.end(JSON.stringify({})); held = null; res.end(JSON.stringify({})); }
        void collect(body).catch(e => errors.push(e.message)); return;
      }
      res.writeHead(404); res.end();
    } catch (e) { errors.push(e.message); res.writeHead(500); res.end(); }
  });
  await new Promise(r => host.listen(0, "127.0.0.1", r));
  browser = await chromium.launch({ headless: true, executablePath: process.env.GRILL_ME_CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 390, height: 350 }, isMobile: true, hasTouch: true });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${host.address().port}`); await page.waitForFunction(() => window.ready);
  const frame = page.frames().find(f => f.url().endsWith("/view")); await frame.locator(".gm-card").waitFor();
  const submissionId = newId();
  const phone = await fetch(`${base}/api/s/${ids.id}/rounds/1/answers`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.writeToken}` },
    body: JSON.stringify({ expectedRevision: 1, submissionId, ...await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "own", text: "Actual phone winner" }] }, grill, { ...ids, round: 1 }) }) });
  assert.equal(phone.status, 204);
  await frame.getByText("This round was submitted from another view. The host follow-up was not confirmed.", { exact: false }).waitFor();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content[0].text, `Grill-me Game: answers ready for session ${ids.id}, round 1, submission ${submissionId}.`);
  assert.equal((await call("grill_ui_state", { link })).structuredContent.snapshot.state, "answered", "rejected notification never ACKs");
  assert.equal(calls.filter(c => c.name === "grill_ui_submit").length, 0, "first round used actual phone HTTP");
  await frame.getByRole("button", { name: "Retry", exact: true }).click();
  await frame.locator(".gm-card").waitFor();
  assert.equal(messages.length, 2); assert.deepEqual(messages[0], messages[1], "retry names the same actual winner");
  assert.match(retained[0].answers, /Actual phone winner/);
  const current = await (await fetch(`${base}/api/s/${ids.id}`)).json();
  assert.equal(current.round, 2); assert.equal(current.state, "pending", "same phone URL advances without replacement");
  assert.equal(page.frames().find(f => f.url().endsWith("/view")), frame, "same view, no re-show");
  await frame.locator(".gm-yes").click(); await frame.getByRole("button", { name: "Send answers", exact: true }).click();
  await frame.locator(".gm-card").waitFor();
  assert.equal(retained.length, 2); assert.match(retained[1].answers, /Q1 - agree/);
  assert.equal(messages.length, 3, "own-submit result and ANSWERED snapshot share one winner notice");
  const third = (await call("grill_ui_state", { link })).structuredContent.snapshot;
  assert.equal(third.round, 3);
  await page.close(); // no live iframe remains to bridge the next phone submission
  const closedPhone = await fetch(`${base}/api/s/${ids.id}/rounds/3/answers`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.writeToken}` },
    body: JSON.stringify({ expectedRevision: third.revision, submissionId: newId(), ...await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }] }, grill, { ...ids, round: 3 }) }) });
  assert.equal(closedPhone.status, 204);
  assert.equal((await call("grill_ui_state", { link })).structuredContent.snapshot.state, "answered");
  assert.equal(messages.length, 3, "a closed view is not a durable wake subscription");
  const final = (await call("grill_wait", { link, round: 3, seconds: 1 })).structuredContent;
  retained.push(final); assert.equal(final.status, "ANSWERS");
  const ack = (await call("grill_ack", { link, receipt: final.receipt })).structuredContent;
  await call("grill_finish", { link, expectedRevision: ack.revision });
  assert.deepEqual(errors, []);
  assert.ok(!JSON.stringify(messages).includes(ids.secret));
});
