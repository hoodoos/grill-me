import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { openRoundAnswers, parseSessionLink } from "../../core/src/session.js";

test("three phone views keep drafts and follow the next round while hosted and CLI answer waits take priority", {
  skip: !process.env.GRILL_ME_BROWSER_TEST, timeout: 25_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || "playwright-core");
  const token = "q".repeat(40), srv = createServer({ statsToken: token, waitersPerGrill: 3, waitersPerIp: 3 });
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  let browser, link, seq = 0;
  const errors = [], requests = [], controllers = [];
  const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  const rpc = async (name, args, signal) => {
    const r = await fetch(base + "/mcp", { method: "POST", headers, signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }) });
    const text = await r.text();
    return JSON.parse(text.startsWith(":") ? text.split("\n").find(x => x.startsWith("data: ")).slice(6) : text).result;
  };
  const stats = async () => (await fetch(base + "/stats/data.json", { headers: { authorization: `Bearer ${token}` } })).json();
  const until = async predicate => {
    const end = performance.now() + 4000;
    while (!(await predicate())) { assert.ok(performance.now() < end, "expected live waiter state"); await new Promise(r => setTimeout(r, 20)); }
  };
  t.after(async () => {
    controllers.forEach(c => c.abort());
    await browser?.close();
    if (link) await rpc("grill_cancel", { link }).catch(() => {});
    srv.server.closeAllConnections(); await srv.close();
  });
  const grill = title => ({ v: 1, questions: [{ n: 1, title, recommend: { why: "Disposable capacity test recommendation" } }] });
  ({ link } = (await rpc("grill_start", {})).structuredContent);
  assert.equal((await rpc("grill_send", { link, round: 1, expectedRevision: 0, grill: grill("Round one") })).isError, undefined);
  const ids = parseSessionLink(link);
  browser = await chromium.launch({ headless: true, ...(process.env.GRILL_ME_BROWSER_EXECUTABLE
    ? { executablePath: process.env.GRILL_ME_BROWSER_EXECUTABLE } : {}) });
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage(); pages.push(page); page.on("pageerror", e => errors.push(e.message));
    page.on("request", req => { const u = new URL(req.url()); if (u.pathname.startsWith("/api/s/")) requests.push({ view: i, search: u.search, at: performance.now() }); });
    await page.goto(link.replace("https://grill-me.ai", base)); await page.locator(".gm-card").waitFor();
    await page.locator(".gm-no").click(); await page.locator("textarea").fill(`Draft in view ${i}`);
  }
  await until(async () => (await stats()).live.waiters === 3);
  const controller = new AbortController(); controllers.push(controller);
  let early;
  const answers = rpc("grill_wait", { link, round: 1, seconds: 5 }, controller.signal).then(value => (early = value));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(early, undefined, "phone update polls cannot reject the hosted answer wait");
  assert.equal((await stats()).live.waiters, 3, "priority does not increase the shared connection cap");
  await pages[0].waitForTimeout(1600);
  assert.ok(requests.some(x => /wait=0/.test(x.search)), "a displaced phone checks state without holding another slot");
  for (let i = 0; i < pages.length; i++) assert.equal(await pages[i].locator("textarea").inputValue(), `Draft in view ${i}`);
  await pages[0].locator(".gm-text .gm-primary").click(); await pages[0].locator(".gm-send").click();
  const received = await answers;
  assert.equal(received.isError, undefined); assert.equal(received.structuredContent.status, "ANSWERS");
  assert.equal(received.structuredContent.answers, "Q1 - Draft in view 0");
  const ack = (await rpc("grill_ack", { link, receipt: received.structuredContent.receipt })).structuredContent;
  await rpc("grill_send", { link, round: 2, expectedRevision: ack.revision, grill: grill("Round two") });
  for (const page of pages) await page.locator(".gm-qtitle").filter({ hasText: "Round two" }).waitFor({ timeout: 4000 });
  // Reload the same links to exercise key recovery and start three fresh held polls.
  // The displaced view otherwise intentionally stays in short-poll mode for ten seconds.
  for (const page of pages) { await page.reload(); await page.locator(".gm-qtitle").filter({ hasText: "Round two" }).waitFor(); }
  await until(async () => (await stats()).live.waiters === 3);
  const rawController = new AbortController(); controllers.push(rawController);
  let rawEarly;
  const raw = fetch(`${base}/api/s/${ids.id}/rounds/2/answers?wait=5`, { signal: rawController.signal }).then(r => (rawEarly = r));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(rawEarly, undefined, "the existing public CLI/library answer endpoint also gets a slot");
  assert.equal((await stats()).live.waiters, 3);
  await pages[1].locator(".gm-yes").click(); await pages[1].locator(".gm-send").click();
  const response = await raw; assert.equal(response.status, 200);
  const body = await response.json(), decrypted = await openRoundAnswers(body, grill("Round two"), { ...ids, round: 2 });
  assert.deepEqual(decrypted.answers, [{ n: 1, kind: "agree" }]);
  const last = (await rpc("grill_ack", { link, receipt: { round: 2, expectedRevision: body.revision, submissionId: body.submissionId } })).structuredContent;
  await rpc("grill_finish", { link, expectedRevision: last.revision });
  for (const page of pages) await page.locator("#message-text").filter({ hasText: "All done" }).waitFor({ timeout: 4000 });
  await until(async () => (await stats()).live.waiters === 0);
  assert.deepEqual(errors, []);
  t.diagnostic("Actual Chrome, three independent phone views, hosted then public answer wait, read-before-ACK, same-link round2 and terminal purge; no provider/model or hardware claim.");
});
