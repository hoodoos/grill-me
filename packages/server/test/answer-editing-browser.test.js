import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { buildSync } from "esbuild";
import { createServer } from "../src/server.js";

for (const mode of ["phone", "inline"]) test(`${mode}: rapid gesture integrity, multi-choice draft/edit and oversize recovery through real answer delivery`, {
  skip: !process.env.GRILL_ME_BROWSER_TEST, timeout: 45_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || "playwright-core");
  const srv = createServer({ log: () => {} }); await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  let seq = 0, host, browser, shown, submits = 0;
  const links = [], errors = [];
  const capture = async (page, name) => {
    if (!process.env.GRILL_ME_ANSWER_EVIDENCE) return;
    await fs.mkdir(process.env.GRILL_ME_ANSWER_EVIDENCE, { recursive: true });
    await page.screenshot({ path: path.join(process.env.GRILL_ME_ANSWER_EVIDENCE, `${mode}-${name}.png`) });
  };
  srv.server.on("request", req => { if (req.method === "POST" && /\/rounds\/\d+\/answers$/.test(req.url)) submits++; });
  const rpc = async (method, params = {}) => {
    const res = await fetch(base + "/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
    const text = await res.text(); return JSON.parse(text.startsWith(":") ? text.split("\n").find(s => s.startsWith("data: ")).slice(6) : text).result;
  };
  const call = async (name, args = {}) => { const result = await rpc("tools/call", { name, arguments: args }); assert.equal(result.isError, undefined); return result; };
  t.after(async () => {
    await browser?.close(); for (const link of links) await call("grill_cancel", { link }).catch(() => {});
    host?.closeAllConnections(); if (host?.listening) await new Promise(r => host.close(r));
    srv.server.closeAllConnections(); await srv.close();
  });
  if (mode === "inline") {
    const catalog = (await rpc("tools/list")).tools;
    const resource = (await rpc("resources/read", { uri: catalog.find(t => t.name === "grill_show")._meta.ui.resourceUri })).contents[0].text;
    const script = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
      import {AppBridge,PostMessageTransport,isToolVisibilityModelOnly} from '@modelcontextprotocol/ext-apps/app-bridge';
      const frame=document.querySelector('iframe'),catalog=await(await fetch('/catalog')).json();
      const bridge=new AppBridge(null,{name:'Controlled answer-editing host',version:'1'},{serverTools:{},message:{text:{}}},{hostContext:{displayMode:'inline',containerDimensions:{height:480,width:390}}});
      bridge.oncalltool=async p=>{if(!catalog.some(t=>t.name===p.name&&!isToolVisibilityModelOnly(t)))throw Error('visibility');return(await fetch('/tool',{method:'POST',body:JSON.stringify(p)})).json();};
      bridge.onmessage=async()=>({});
      bridge.oninitialized=async()=>{await bridge.sendToolResult(await(await fetch('/shown')).json());window.ready=true;};
      window.resizeView=height=>{frame.style.height=height+'px';bridge.setHostContext({displayMode:'inline',containerDimensions:{height,width:390}});};
      await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/view';
    ` }, bundle: true, write: false, platform: "browser", format: "esm" }).outputFiles[0].text;
    host = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const c of req) chunks.push(c); res.setHeader("cache-control", "no-store");
        if (req.url === "/") { res.setHeader("content-type", "text/html"); return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{border:0;width:390px;height:480px}</style><iframe sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script>'); }
        if (req.url === "/host.js") { res.setHeader("content-type", "text/javascript"); return res.end(script); }
        if (req.url === "/view") { res.setHeader("content-type", "text/html"); res.setHeader("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"); return res.end(resource); }
        res.setHeader("content-type", "application/json");
        if (req.url === "/catalog") return res.end(JSON.stringify(catalog));
        if (req.url === "/shown") return res.end(JSON.stringify(shown));
        if (req.url === "/tool") { const body = JSON.parse(Buffer.concat(chunks)); if (body.name === "grill_ui_submit") submits++; return res.end(JSON.stringify(await rpc("tools/call", body))); }
        res.writeHead(404); res.end();
      } catch (e) { errors.push(e.message); res.writeHead(500); res.end(); }
    }); await new Promise(r => host.listen(0, "127.0.0.1", r));
  }
  browser = await chromium.launch({ headless: true, ...(process.env.GRILL_ME_BROWSER_EXECUTABLE ? { executablePath: process.env.GRILL_ME_BROWSER_EXECUTABLE } : {}) });
  const q = (n, extra = {}) => ({ n, title: `Question ${n}`, recommend: { why: "Disposable recommendation" }, ...extra });
  const open = async questions => {
    const { link } = (await call("grill_start")).structuredContent; links.push(link);
    await call("grill_send", { link, round: 1, expectedRevision: 0, grill: { v: 1, questions } });
    if (mode === "inline") shown = await call("grill_show", { link });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); page.setDefaultTimeout(4000); page.on("pageerror", e => errors.push(e.message));
    await page.goto(mode === "phone" ? link.replace("https://grill-me.ai", base) : `http://127.0.0.1:${host.address().port}`);
    if (mode === "inline") await page.waitForFunction(() => window.ready);
    const view = mode === "phone" ? page : page.frames().find(f => f.url().endsWith("/view"));
    await view.locator(".gm-card:not(.enter)").waitFor();
    return { page, context, view, link };
  };
  const finish = async (f, expected) => {
    const result = (await call("grill_wait", { link: f.link, round: 1, seconds: 1 })).structuredContent;
    assert.equal(result.status, "ANSWERS"); assert.equal(result.answers, expected);
    const ack = (await call("grill_ack", { link: f.link, receipt: result.receipt })).structuredContent;
    await call("grill_finish", { link: f.link, expectedRevision: ack.revision }); await f.context.close();
  };
  for (const [input, action] of [["touch", ".gm-yes"], ["touch", "Skip"], ["mouse", ".gm-yes"]]) {
    const f = await open([q(1), q(2), q(3)]), b = await f.view.locator(".gm-card").boundingBox();
    let finger;
    if (input === "touch") {
      finger = await f.context.newCDPSession(f.page);
      await finger.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b.x + b.width / 2, y: b.y + 65 }] });
      for (let i = 1; i <= 6; i++) await finger.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: b.x + b.width / 2 + 160 * i / 6, y: b.y + 65 }] });
      await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else { await f.page.mouse.move(b.x + b.width / 2, b.y + 65); await f.page.mouse.down(); await f.page.mouse.move(b.x + b.width / 2 + 160, b.y + 65, { steps: 5 }); await f.page.mouse.up(); }
    const control = action === "Skip" ? f.view.getByRole("button", { name: "Skip", exact: true }) : f.view.locator(action);
    assert.equal(await control.isDisabled(), true, "accepted swipe owns its original card until commit");
    const target = await control.boundingBox(), x = target.x + target.width / 2, y = target.y + target.height / 2;
    if (finger) { await finger.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await finger.detach(); }
    else await f.page.mouse.click(x, y);
    await f.view.locator(".gm-qtitle").filter({ hasText: "Question 2" }).waitFor();
    await f.page.waitForTimeout(220); assert.equal(await f.view.locator(".gm-qtitle").textContent(), "Question 2");
    await f.view.locator(".gm-no").click(); await f.view.locator("textarea").fill("Deliberate second answer"); await f.view.locator(".gm-text .gm-primary").click();
    await f.view.locator(".gm-yes").click(); await f.view.locator(".gm-send").click();
    await finish(f, "Q1 - agree\nQ2 - Deliberate second answer\nQ3 - agree");
  }
  {
    const f = await open([q(1, { multi: true, choices: [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }] })]);
    await f.view.getByRole("button", { name: "Alpha", exact: true }).click(); await f.view.getByRole("button", { name: "Beta", exact: true }).click();
    if (mode === "phone") { await f.page.reload(); await f.view.locator(".gm-card").waitFor(); }
    else { await f.page.locator("body").click({ position: { x: 1, y: 800 } }); await f.page.evaluate(() => window.resizeView(150)); await f.view.locator("#compact").waitFor(); await f.page.evaluate(() => window.resizeView(480)); }
    assert.equal(await f.view.locator(".gm-choices button.on").count(), 2);
    await capture(f.page, "restored-multi");
    await f.view.locator(".gm-multi-next").click(); assert.equal(await f.view.locator(".gm-a").textContent(), "Alpha, Beta");
    await f.view.locator(".gm-qrow").click(); assert.equal(await f.view.locator(".gm-choices button.on").count(), 2);
    await f.view.getByRole("button", { name: "Beta", exact: true }).click(); await f.view.getByRole("button", { name: "Gamma", exact: true }).click();
    await f.view.locator(".gm-multi-next").click(); await f.view.locator(".gm-send").click(); await finish(f, "Q1 - Alpha, Gamma");
  }
  for (const multilingual of [false, true]) {
    const f = await open(multilingual ? [q(1)] : [q(1), q(2), q(3)]), text = (multilingual ? "界" : "a").repeat(3000);
    for (let i = 0; i < (multilingual ? 1 : 3); i++) {
      await f.view.locator(".gm-no").click();
      if (multilingual) { await f.view.locator("textarea").fill("a".repeat(4001)); await f.view.locator(".gm-text .gm-primary").click(); assert.equal(await f.view.locator("textarea").inputValue(), "a".repeat(4001)); assert.match(await f.view.locator(".gm-scroll .gm-note").textContent(), /4000/); }
      await f.view.locator("textarea").fill(text); await f.view.locator(".gm-text .gm-primary").click();
    }
    const before = submits; await f.view.locator(".gm-send").click();
    assert.match(await f.view.locator(".gm-note").textContent(), /too long to send together.*Shorten/);
    if (multilingual) await capture(f.page, "long-answer-guidance");
    assert.equal(submits, before, "oversize input is rejected before any submission request");
    assert.equal((await call("grill_ui_state", { link: f.link })).structuredContent.snapshot.state, "pending");
    assert.equal(await f.view.locator(".gm-a").first().textContent(), text);
    for (let i = multilingual ? 0 : 1; i < (multilingual ? 1 : 3); i++) {
      await f.view.locator(".gm-qrow").nth(i).click(); await f.view.locator(".gm-no").click(); await f.view.locator("textarea").fill("Shortened answer"); await f.view.locator(".gm-text .gm-primary").click();
    }
    await f.view.locator(".gm-send").click();
    await finish(f, multilingual ? "Q1 - Shortened answer" : `Q1 - ${text}\nQ2 - Shortened answer\nQ3 - Shortened answer`);
  }
  assert.deepEqual(errors, []);
  t.diagnostic("Actual browser + real relay, encrypted agent output/read-before-ACK. Official AppBridge uses a controlled host; no provider/model/hardware claim.");
});
