import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "../src/server.js";

test("homepage: real local swipes, viewport paint, replay and honest exact clipboard copies", {
  skip: !process.env.GRILL_ME_BROWSER_TEST, timeout: 40_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || "playwright-core");
  const relay = createServer(); let browser;
  await new Promise(r => relay.server.listen(0, "127.0.0.1", r));
  t.after(async () => { await browser?.close(); await relay.close(); });
  const requests = [], errors = [], geometry = [], paints = [];
  relay.server.on("request", req => requests.push(req.url));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.GRILL_ME_BROWSER_EXECUTABLE
    ? { executablePath: process.env.GRILL_ME_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage(); page.on("pageerror", e => errors.push(String(e)));
  await page.addInitScript(() => {
    const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    globalThis.clipboardPayloads = [];
    navigator.clipboard.writeText = async text => { clipboardPayloads.push(text); await nativeWrite(text); };
  });
  const evidence = process.env.GRILL_ME_BROWSER_EVIDENCE;
  const screenshot = async name => {
    if (evidence) {
      await page.waitForFunction(() => !document.querySelector(".gm-card.enter"));
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getTiming().iterations)).map(a => a.finished.catch(() => {}))); });
      await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + ".png") });
    }
  };
  await page.goto(base); await page.locator(".gm-card:not(.enter)").waitFor();
  assert.equal(await page.locator(".gm-qtitle").textContent(), "Do you know what grilling is?");
  const swipe = async (direction, paint = false) => {
    const card = page.locator(".gm-card");
    await page.waitForFunction(() => !document.querySelector(".gm-card")?.classList.contains("enter"));
    const b = await card.boundingBox(), x = b.x + b.width / 2, y = b.y + Math.min(92, b.height / 2);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + direction * 240 * i / 8, y }] });
    const mid = await card.evaluate((el, dir) => {
      const p = new DOMPoint(dir > 0 ? el.offsetWidth - 25 : 25, el.offsetHeight / 2);
      const matrix = new DOMMatrix(getComputedStyle(el).transform);
      const b = el.getBoundingClientRect();
      // elementFromPoint at an interior local coordinate mapped through CSS transform.
      const origin = getComputedStyle(el).transformOrigin.split(" ").map(parseFloat);
      const q = matrix.transformPoint(new DOMPoint(p.x - origin[0], p.y - origin[1]));
      const center = matrix.transformPoint(new DOMPoint(0, 0));
      const x = innerWidth / 2 + q.x - center.x + matrix.e, y = b.y + b.height / 2;
      return { transform: getComputedStyle(el).transform, stamp: +getComputedStyle(el.querySelector(dir > 0 ? ".agree" : ".own")).opacity,
        painted: !!document.elementFromPoint(x, y)?.closest(".gm-card"), x, y };
    }, direction);
    assert.ok(mid.stamp > .9); assert.notEqual(mid.transform, "none");
    if (paint) { assert.ok(mid.x > 0 && mid.x < 1280); assert.ok(mid.painted, JSON.stringify(mid)); paints.push(mid); }
    await screenshot(`swipe-${paint ? "desktop" : "mobile"}-${direction}`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
  };
  await screenshot("home-390x844"); await swipe(1);
  await page.getByText("How would you answer?", { exact: true }).waitFor();
  await swipe(-1); await page.locator("textarea").waitFor();
  await page.locator("textarea").fill("My local perspective"); await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("Ready for the next good question?", { exact: true }).waitFor();
  await page.locator(".gm-yes").click();
  await page.getByRole("button", { name: "Finish demo", exact: true }).click();
  assert.ok(await page.locator("#home-complete").isVisible());
  assert.equal(await page.getByText("This was just a local demo. Nothing was sent or saved.", { exact: true }).count(), 1);
  await screenshot("home-complete"); await page.locator("#home-replay").click();
  assert.equal(await page.locator(".gm-qtitle").textContent(), "Do you know what grilling is?");

  for (const [width, height] of [[390, 844], [390, 350], [1280, 800]]) {
    await page.setViewportSize({ width, height }); await page.locator(".gm-no").click();
    await page.locator("textarea").fill("Current demo draft");
    const g = await page.evaluate(() => {
      const b = s => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
        hero: b(".home-play"), card: b(".gm-card"), input: b("textarea"), next: b(".gm-text .gm-primary"), bar: b(".gm-bar"), tools: b(".home-demo-tools") };
    });
    geometry.push(g); assert.equal(g.scrollWidth, width);
    assert.ok(g.next.bottom <= g.card.bottom && g.next.bottom < g.bar.top, JSON.stringify(g));
    assert.ok(g.input.bottom <= g.next.top && g.tools.bottom <= height, JSON.stringify(g));
    await screenshot(`own-${width}x${height}`); await page.locator("#home-replay").click();
  }
  await swipe(1, true); await page.getByText("How would you answer?", { exact: true }).waitFor();
  await swipe(-1, true); await page.locator("textarea").waitFor();
  await page.locator("#home-replay").click();
  await page.emulateMedia({ colorScheme: "dark" }); await screenshot("home-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("link", { name: "Skip to install" }).click();
  await page.getByRole("heading", { name: "Paste into your agent", exact: true }).waitFor();
  const expected = "Install Grill Me from https://grill-me.ai/";
  await page.evaluate(() => {
    const write = navigator.clipboard.writeText;
    navigator.clipboard.writeText = text => new Promise(resolve => {
      globalThis.releaseCopy = async () => { await write(text); resolve(); navigator.clipboard.writeText = write; };
    });
  });
  await page.getByRole("button", { name: "Copy install prompt", exact: true }).click();
  assert.equal(await page.locator(".home-paste button").textContent(), "Copy");
  assert.equal(await page.locator(".home-paste .copy-status").textContent(), "");
  await page.evaluate(() => releaseCopy());
  await page.locator(".home-paste .copy-status").filter({ hasText: "Copied to clipboard." }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
  await screenshot("install-copy-success");
  await page.getByRole("button", { name: "Copy install prompt", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".home-paste button").disabled);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected, "keyboard copy");
  const blocks = await page.locator("#install-commands pre code").allTextContents();
  const rawBlocks = await page.evaluate(async () => {
    const html = await (await fetch("/", { headers: { accept: "text/html" } })).text();
    return [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("#install-commands pre code")].map(e => e.textContent);
  });
  assert.deepEqual(blocks, rawBlocks, "progressive Copy controls leave original rendered command text/newlines intact");
  assert.ok(blocks.some(b => b.includes("\n")));
  for (const [i, block] of blocks.entries()) {
    await page.getByRole("button", { name: `Copy command block ${i + 1}`, exact: true }).click();
    await page.locator(`#install-command-${i + 1}`).locator("../..").locator(".copy-status").filter({ hasText: "Copied to clipboard." }).waitFor();
    assert.equal(await page.evaluate(() => clipboardPayloads.at(-1)), block, `exact writeText argument/newlines ${i + 1}`);
    const readback = await page.evaluate(() => navigator.clipboard.readText());
    // Windows' native clipboard uses CRLF. Only that OS line-ending conversion is allowed;
    // the actual writeText payload above must be byte-for-byte the rendered command text.
    assert.equal(readback, process.platform === "win32" ? block.replace(/\n/g, "\r\n") : block,
      `native clipboard readback ${i + 1}`);
  }
  // Deliberately reject the actual clipboard API: never report success on failure.
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException("Denied", "NotAllowedError"); }; });
  await page.getByRole("button", { name: "Copy install prompt", exact: true }).click();
  assert.equal(await page.locator(".home-paste button").textContent(), "Copy");
  assert.match(await page.locator(".home-paste .copy-status").textContent(), /Couldn't copy/);
  assert.equal(await page.evaluate(() => getSelection().toString()), expected);
  await screenshot("copy-failure-manual-selection");
  for (const width of [390, 350, 1280]) {
    await page.setViewportSize({ width, height: 844 }); await page.locator("#install").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await screenshot(`install-${width}`);
  }
  assert.equal(requests.some(p => p.startsWith("/api/")), false, "homepage never uses the relay");
  assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
  await page.reload(); await page.locator(".gm-qtitle").waitFor();
  assert.equal(await page.locator(".gm-qtitle").textContent(), "Do you know what grilling is?");
  assert.deepEqual(errors, []);
  assert.ok(requests.some(p => /^\/home-demo\.js\?v=[0-9a-f]{12}$/.test(p)));
  assert.ok(requests.some(p => /^\/home\.css\?v=[0-9a-f]{12}$/.test(p)));
  console.log(JSON.stringify({ result: "PASS", realCDPTouch: true, localOnly: true, exactClipboardReadback: true,
    commandBlocks: blocks.length, failureSelection: true, geometry, paints, pageerrors: errors, requests }, null, 2));
});
