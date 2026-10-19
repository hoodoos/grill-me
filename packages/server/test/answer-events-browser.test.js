import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "../src/server.js";

test("actual phone swipes -> signed local receiver wake -> next frontier and final confirmation, without a chat nudge", {
  skip: !process.env.GRILL_ME_BROWSER_TEST || !process.env.GRILL_ME_MCP_SDK_MODULE, timeout: 45_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || "playwright-core");
  const sdk = process.env.GRILL_ME_MCP_SDK_MODULE.replace(/\/$/, "");
  const { Client } = await import(sdk + "/client/index.js"), { StreamableHTTPClientTransport } = await import(sdk + "/client/streamableHttp.js");
  const secret = "whsec_" + crypto.randomBytes(32).toString("base64"), key = Buffer.from(secret.slice(6), "base64");
  const hostContext = [], events = [], failures = [], errors = [], handled = new Set();
  let receiver, srv, browser, client, privateLink, base, subscription;
  const controller = new AbortController();
  t.after(async () => {
    controller.abort(); await browser?.close();
    if (privateLink && client) try { await client.callTool({ name: "grill_cancel", arguments: { link: privateLink } }); } catch {}
    await client?.close();
    receiver?.closeAllConnections(); if (receiver?.listening) await new Promise(r => receiver.close(r));
    srv?.server.closeAllConnections(); if (srv) await srv.close();
  });
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, undefined, "host tool completed"); return r.structuredContent;
  };
  const questions = round => ({ v: 1, questions: [{ n: 1, title: round === 3 ? "Confirm our shared understanding" : `Ready frontier ${round}`,
    body: round === 3 ? "The decisions are retained in the host. Confirm this understanding on your phone." : "Stay on this phone page; the next ready frontier arrives automatically.",
    recommend: { why: "Agree to this disposable recommendation" } }] });
  // This scripted HOST is the local test receiver, not a model/provider/account claim.
  const continueInterview = async event => {
    if (handled.has(event.eventId)) return; handled.add(event.eventId);
    const round = event.data.round, result = await call("grill_wait", { link: privateLink, round, seconds: 1 });
    assert.equal(result.status, "ANSWERS");
    hostContext.push({ round, answers: result.answers, frontier: round < 3 ? round + 1 : "confirmed" }); // host retains BEFORE ACK
    const ack = await call("grill_ack", { link: privateLink, receipt: result.receipt });
    if (round < 3) await call("grill_send", { link: privateLink, round: round + 1, expectedRevision: ack.revision, grill: questions(round + 1) });
    else assert.equal((await call("grill_finish", { link: privateLink, expectedRevision: ack.revision })).status, "FINISHED");
  };
  receiver = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const raw = Buffer.concat(chunks);
      const signed = `${req.headers["webhook-id"]}.${req.headers["webhook-timestamp"]}.`;
      const expected = "v1," + crypto.createHmac("sha256", key).update(signed).update(raw).digest("base64");
      assert.equal(req.headers["webhook-signature"], expected);
      const body = JSON.parse(raw); res.setHeader("content-type", "application/json");
      if (body.type === "verification") { res.end(JSON.stringify({ challenge: body.challenge })); return; }
      assert.equal(req.headers["x-mcp-subscription-id"], subscription);
      assert.equal(body.name, "grill.answers_ready"); events.push({ id: body.eventId, round: body.data.round });
      res.writeHead(202); res.end("{}");
      setImmediate(() => void continueInterview(body).catch(e => failures.push(e.message)));
    } catch (e) { failures.push(e.message); res.writeHead(400); res.end(); }
  });
  await new Promise(r => receiver.listen(0, "127.0.0.1", r));
  const receiverBase = `http://127.0.0.1:${receiver.address().port}`;
  srv = createServer({ eventOptions: { tickMs: 10, post: async (_destination, request) => {
    // Explicit isolated wire-routing seam ONLY. Production uses public pinned HTTPS.
    const r = await fetch(receiverBase + "/callback", { method: "POST", headers: request.headers, body: request.body, signal: request.signal });
    return { status: r.status, body: await r.text() };
  } } });
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${srv.server.address().port}`;
  client = new Client({ name: "scripted-host-compatibility", version: "1.32.1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp")); await client.connect(transport); assert.equal(transport.sessionId, undefined);
  assert.equal((await client.listTools()).tools.length, 11);
  privateLink = (await call("grill_start")).link;
  const subscribed = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "events/subscribe" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "subscribe", method: "events/subscribe", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
      name: "grill.answers_ready", arguments: { link: privateLink }, delivery: { mode: "webhook", url: "https://receiver.example/callback", secret } } }) });
  const result = await subscribed.json(); assert.ok(result.result?.id, "signed challenge succeeds before publication"); subscription = result.result.id;
  await call("grill_send", { link: privateLink, round: 1, expectedRevision: 0, grill: questions(1) });
  browser = await chromium.launch({ headless: true, ...(process.env.GRILL_ME_BROWSER_EXECUTABLE ? { executablePath: process.env.GRILL_ME_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  const navigation = [], cdp = await context.newCDPSession(page);
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigation.push(frame.url().split("#")[0]); });
  const phoneLink = privateLink.replace("https://grill-me.ai", base);
  await page.goto(phoneLink); await page.locator(".gm-card").waitFor();
  for (const round of [1, 2, 3]) {
    const title = round === 3 ? "Confirm our shared understanding" : `Ready frontier ${round}`;
    try { await page.locator(".gm-card").filter({ hasText: title }).waitFor({ timeout: 5000 }); }
    catch (e) {
      console.log(JSON.stringify({ failedRound: round, events, hostContext, failures, errors,
        pageState: await page.locator("body").innerText() })); throw e;
    }
    if (round === 2) {
      await page.setViewportSize({ width: 390, height: 350 });
      await page.reload(); await page.locator(".gm-card").filter({ hasText: title }).waitFor();
    }
    const box = await page.locator(".gm-card").boundingBox(), x = box.x + box.width / 2, y = box.y + 50;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 160 * i / 6, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.locator(".gm-send").waitFor(); await page.locator(".gm-send").click();
  }
  await page.locator("#message-text").filter({ hasText: "All done" }).waitFor();
  assert.deepEqual(hostContext.map(v => v.round), [1, 2, 3]); assert.deepEqual(hostContext.map(v => v.answers), ["Q1 - agree", "Q1 - agree", "Q1 - agree"]);
  assert.deepEqual(events.map(v => v.round), [1, 2, 3]); assert.equal(new Set(events.map(v => v.id)).size, 3);
  assert.ok(navigation.every(url => url === phoneLink.split("#")[0]), "phone never leaves the original interview route");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("gm:s2:")).length), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(errors, []); assert.deepEqual(failures, []);
  if (process.env.GRILL_ME_BROWSER_EVIDENCE) {
    await fs.mkdir(process.env.GRILL_ME_BROWSER_EVIDENCE, { recursive: true });
    await page.screenshot({ path: path.join(process.env.GRILL_ME_BROWSER_EVIDENCE, "answer-wake-finished-390x350.png") });
  }
  console.log(JSON.stringify({ result: "PASS", attribution: "Actual Chrome/CDP phone + real signed local HTTP receiver/scripted host; official legacy SDK1.32.1 compatibility, NOT actual provider/model/account or physical phone", samePhoneRoute: true,
    rounds: 3, finalConfirmationOnPhone: true, chatNudges: 0, hostRetainedBeforeAck: true, swipes: "real CDP touch", sendControl: "browser button click", reload: true, shortViewport: "390x350", finishedPurge: true, pageerrors: errors }, null, 2));
});
