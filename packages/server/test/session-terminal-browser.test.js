import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { sendRound, wait, finish, cancel } from "../../cli/src/index.js";
import { readPending } from "../../cli/src/pending.js";
import { deriveSessionKeys, sealRoundAnswers } from "../../core/src/session.js";
import { newId, newSecret } from "../../core/src/crypto.js";

test("terminal reasons in actual browser: warm0.2 cache, open poll, reconnect, no-key reload and stale-tab purge", {
  skip: !process.env.GRILL_ME_BROWSER_TEST, timeout: 45_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || "playwright-core");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const pin = "5f48a90fae6d46f2467a8d604030aef2ec504fa8";
  const frozen = new Map(["grill.html", "entry-020.js", "session-app.js", "style.css"].map(name => ["/" + name,
    execFileSync("git", ["show", `${pin}:packages/server/public/${name}`], { cwd: root })]));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gm-terminal-browser-"));
  let relay, proxy, browser, page, clock = Date.now(), phase = 1;
  const requests = [], errors = [];
  t.after(async () => {
    if (page && !page.isClosed()) t.diagnostic(JSON.stringify({ pageState: await page.evaluate(() => ({
      online: navigator.onLine, visibility: document.visibilityState, text: document.getElementById("message-text")?.textContent,
    })).catch(() => null), requests }));
    await browser?.close();
    if (proxy) { proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); }
    await relay?.close(); await fs.rm(home, { recursive: true, force: true });
  });
  relay = createServer({ now: () => clock, sweepMs: 20 });
  await new Promise(r => relay.server.listen(0, "127.0.0.1", r));
  proxy = http.createServer((req, res) => {
    const url = new URL(req.url, "http://test"); requests.push({ phase, url: req.url });
    const old = phase === 1 ? frozen.get(url.pathname.startsWith("/g/") ? "/grill.html" : url.pathname) : null;
    if (old) {
      res.writeHead(200, { "content-type": url.pathname.startsWith("/g/") ? "text/html" : url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
        "cache-control": url.pathname.startsWith("/g/") ? "no-store" : "public,max-age=300" }); return res.end(old);
    }
    const upstream = http.request({ host: "127.0.0.1", port: relay.server.address().port,
      path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    upstream.on("error", () => res.destroy()); res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  await new Promise(r => proxy.listen(0, "127.0.0.1", r));
  const opts = { home, server: `http://127.0.0.1:${proxy.address().port}` };
  browser = await chromium.launch({ headless: true, ...(process.env.GRILL_ME_BROWSER_EXECUTABLE
    ? { executablePath: process.env.GRILL_ME_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await context.newPage(); page.on("pageerror", e => errors.push(String(e)));
  const grill = { v: 1, questions: [{ n: 1, title: "Disposable", body: "Current round only", recommend: { why: "Test" } }] };
  const text = value => page.locator("#message-text").filter({ hasText: value }).waitFor({ timeout: 8000 });
  const finished = "All done—your agent has finished this grill.";
  const cancelled = "This grill was cancelled.";
  const thinking = "Your agent is thinking. Keep this page open—your next questions will appear here.";
  const evidence = process.env.GRILL_ME_BROWSER_EVIDENCE;
  const screenshots = async name => {
    if (evidence) { await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + ".png") }); }
  };
  const purged = async p => assert.equal(await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("gm:s2:")).length), 0);

  // A real same-origin warm0.2 context; no hard reload, cache clear or network-route override.
  const warm = await sendRound(grill, opts);
  await page.goto(warm.link); await page.locator(".gm-card").waitFor();
  await cancel(warm.id, opts); await text("Session ended or expired.");
  phase = 2;
  const session = await sendRound(grill, opts);
  await page.goto(session.link); await page.locator(".gm-card").waitFor();
  const record = await readPending(home, session.id), keys = await deriveSessionKeys(record.secret);
  const refused = await fetch(`${opts.server}/api/s/${session.id}/finish`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.writeToken}` }, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(refused.status, 409); assert.equal(await page.locator(".gm-card").isVisible(), true);
  assert.equal(await page.getByText(finished, { exact: true }).count(), 0);
  const other = await context.newPage(); other.on("pageerror", e => errors.push(String(e)));
  await other.goto(session.link); await other.locator(".gm-no").click();
  await other.locator("textarea").fill("Disposable stale draft");
  await other.evaluate(() => { globalThis.oldInput = document.querySelector("textarea"); });
  await page.bringToFront(); // exercise the active phone tab; the other remains a storage-event peer
  const box = await page.locator(".gm-card").boundingBox(), x = box.x + box.width / 2, y = box.y + 100;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 160 * i / 6, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
  await page.locator(".gm-send").click(); await page.locator("#screen-done:not([hidden])").waitFor();
  assert.equal(await page.locator("#thinking-stack").count(), 0, "Sent is not proof of pickup/ACK");
  const answers = await wait(session.id, { ...opts, seconds: 10 }); assert.equal(answers.lines, "Q1 - agree"); await answers.ack();
  await text(thinking);
  const geometry = [];
  for (const [width, height] of [[390, 844], [390, 350], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    const bounds = await page.evaluate(() => {
      const stack = document.getElementById("thinking-stack");
      const rects = [stack, document.getElementById("message-text")].map(el => {
        const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      return { rects, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
        animations: stack.getAnimations({ subtree: true }).map(a => ({ state: a.playState, iterations: a.effect.getTiming().iterations })) };
    });
    assert.equal(bounds.width, width); assert.equal(bounds.height, height);
    assert.ok(bounds.rects.every(r => r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= height));
    assert.equal(bounds.animations.length, 3); assert.ok(bounds.animations.every(a => a.state === "running" && a.iterations === Infinity));
    assert.equal(await page.locator(".session-thinking a:visible").count(), 0);
    assert.equal(await page.locator("#thinking-stack").getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator("#thinking-stack a, #thinking-stack button").count(), 0);
    geometry.push({ width, height, rects: bounds.rects }); await screenshots(`thinking-${width}x${height}`);
  }
  await page.waitForFunction(() => document.getElementById("thinking-stack").getAnimations({ subtree: true }).some(a => a.currentTime > 100));
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator("#thinking-stack").evaluate(el => el.getAnimations({ subtree: true }).length), 0);
  assert.ok(await page.locator("#thinking-stack span").evaluateAll(els => els.every(el => getComputedStyle(el).animationName === "none")));
  await screenshots("thinking-reduced-motion");
  await page.emulateMedia({ reducedMotion: "no-preference" }); await page.setViewportSize({ width: 390, height: 844 });
  await sendRound(grill, { ...opts, id: session.id, round: 2 });
  await page.locator(".gm-card").waitFor(); assert.equal(await page.locator("#thinking-stack").count(), 0);
  await page.locator(".gm-yes").click(); await page.locator(".gm-send").click();
  await page.locator("#screen-done:not([hidden])").waitFor(); assert.equal(await page.locator("#thinking-stack").count(), 0);
  const second = await wait(session.id, { ...opts, seconds: 10 }); assert.equal(second.lines, "Q1 - agree"); await second.ack();
  await text(thinking);
  await finish(session.id, opts); await text(finished);
  assert.equal(await page.getByRole("link", { name: "Grill Me", exact: true }).isVisible(), true);
  assert.equal(await page.locator("#thinking-stack").count(), 0); await screenshots("finished");
  await other.locator("#message-text").filter({ hasText: finished }).waitFor();
  await other.evaluate(() => { oldInput.value = "late stale plaintext"; oldInput.dispatchEvent(new Event("input", { bubbles: true })); });
  await purged(page); await purged(other);
  assert.equal(new URL(page.url()).hash, "");
  await page.reload(); await text(finished); await purged(page); // no key remains: public receipt resolves it
  await other.close();

  // Isolate the controlled gap from the cross-tab scenario. Put a separate real session into
  // idle before the phone boots, and install the one-shot timer barrier before any module runs.
  // The first poll must return the existing idle snapshot; its following150ms gap is therefore
  // captured regardless of whether syncOnce or pollLoop rendered the thinking class first.
  const gap = await sendRound(grill, opts), gapRecord = await readPending(home, gap.id);
  const gapKeys = await deriveSessionKeys(gapRecord.secret), submissionId = newId();
  const gapBlob = await sealRoundAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }] }, grill,
    { id: gap.id, secret: gapRecord.secret, round: 1 });
  assert.equal((await fetch(`${opts.server}/api/s/${gap.id}/rounds/1/answers`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gapKeys.writeToken}` },
    body: JSON.stringify({ expectedRevision: 1, submissionId, ...gapBlob }) })).status, 204);
  const gapAnswers = await wait(gap.id, { ...opts, seconds: 10 }); await gapAnswers.ack();
  await page.addInitScript(id => {
    if (location.pathname !== `/g/${id}`) return;
    const timer = globalThis.setTimeout;
    let held = false;
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms === 150 && !held) {
        held = true;
        globalThis.releaseIdlePollGap = () => { globalThis.setTimeout = timer; fn(...args); };
        return 0;
      }
      return timer(fn, ms, ...args);
    };
  }, gap.id);
  await page.goto(gap.link); await text(thinking);
  await page.waitForFunction(() => typeof globalThis.releaseIdlePollGap === "function", null, { timeout: 8000 });
  assert.equal(requests.some(r => r.url === `/api/s/${gap.id}?after=3&wait=50`), false,
    "the idle polling gap is held before a next long poll can be in flight");
  await context.setOffline(true); await text("Can't reach grill-me.ai right now.");
  assert.equal(await page.locator("#thinking-stack").count(), 0, "errors must not keep loading decoration");
  const beforeReconnect = requests.length;
  await context.setOffline(false); await page.evaluate(() => globalThis.releaseIdlePollGap()); await text(thinking);
  assert.ok(requests.slice(beforeReconnect).some(r => r.url === `/api/s/${gap.id}?wait=0`),
    "reconnect performs a real immediate state recheck rather than waiting50s");
  await finish(gap.id, opts); await text(finished); await purged(page);

  // Termination in a polling gap/offline interval, then reconnect and reload.
  const away = await sendRound(grill, opts);
  await page.goto(away.link); await page.locator(".gm-no").click(); await page.locator("textarea").fill("Offline current draft");
  await context.setOffline(true);
  await cancel(away.id, opts); // Node HTTPS equivalent is outside the browser's offline context
  await context.setOffline(false); await text(cancelled); await purged(page);
  await page.reload(); await text(cancelled);

  // A relay clock seam, not device/OS clock editing. Sweeper expiry wakes an open phone.
  const expiring = await sendRound(grill, opts);
  await page.goto(expiring.link); await page.locator(".gm-card").waitFor();
  clock += 3_600_001; await text("This session expired."); await purged(page);
  await page.reload(); await text("This session expired.");
  // Old finished receipt has now passed its ten-minute bound; no invented finished state.
  await page.goto(session.link.split("#")[0]); await text("Session ended or expired.");
  const unknown = `${opts.server}/g/${newId()}?session=2#${newSecret()}`;
  await page.goto(unknown); await text("Session ended or expired."); await purged(page);
  await page.reload(); await text("Session ended or expired.");
  assert.deepEqual(errors, []);
  for (const url of ["/entry-020.js", "/session-app.js"]) assert.ok(requests.some(r => r.phase === 1 && r.url === url));
  for (const url of ["/entry-020.js?v=wait-capacity-3", "/session-app.js?v=wait-capacity-3"]) assert.ok(requests.some(r => r.phase === 2 && r.url === url));
  assert.ok(requests.some(r => r.phase === 1 && r.url === "/style.css?v=c0fdf4f95f99"));
  assert.ok(requests.some(r => r.phase === 2 && r.url.startsWith("/style.css?v=") && r.url !== "/style.css?v=c0fdf4f95f99"));
  assert.equal(requests.some(r => r.phase === 2 && ["/entry-020.js", "/session-app.js", "/core/session.js", "/ui/grill.js", "/ui/grill.css"].includes(r.url)), false,
    "changed modules use fresh URLs; unchanged dependencies/styles actually reuse the warm cache");
  console.log(JSON.stringify({ result: "PASS", realTouch: true, warm02Cache: true, cacheCleared: false,
    finish: "open longpoll and no-key reload", pendingFinish409: true, cancel: "offline polling gap/reconnect/reload",
    expiry: "open poll and reload", unknownNeverFinished: true, markerExpiryGeneric: true, staleTabPurge: true,
    thinkingAfterAckOnly: true, controlledIdlePollingGap: "single-tab, idle-before-boot, pre-module one-shot barrier",
    reducedMotionStatic: true, nextRoundReplacesAnimation: true, geometry, pageerrors: errors, requests }, null, 2));
});
