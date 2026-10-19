import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { buildSync } from "esbuild";
import { createServer } from "../src/server.js";

test("official AppBridge sizing: soft ceiling, fixed350, fullscreen safe insets and partial inline return without resize feedback", {
  skip: !process.env.GRILL_ME_APPS_BROWSER, timeout: 20_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || "playwright-core");
  const srv = createServer({ db: ":memory:", log: () => {} });
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  let browser, host, link, seq = 0;
  const errors = [], measurements = [];
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  t.after(async () => { try { await browser?.close(); if (link) await call("grill_cancel", { link }); } finally { host?.closeAllConnections(); if (host?.listening) await new Promise(r => host.close(r)); srv.server.closeAllConnections(); await srv.close(); } });
  const rpc = async (method, params = {}) => {
    const res = await fetch(base + "/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
    const raw = await res.text(); return JSON.parse(raw.startsWith(":") ? raw.split("\n").find(s => s.startsWith("data: ")).slice(6) : raw).result;
  };
  const call = async (name, args = {}) => { const result = await rpc("tools/call", { name, arguments: args }); assert.ok(!result.isError); return result; };
  ({ link } = (await call("grill_start")).structuredContent);
  await call("grill_send", { link, round: 1, expectedRevision: 0, grill: { v: 1, questions: [{ n: 1, title: "Host sizing fixture", body: "Current draft must survive display-mode changes.", recommend: { why: "A disposable layout check" } }] } });
  const shown = await call("grill_show", { link }), catalog = (await rpc("tools/list")).tools;
  const resource = (await rpc("resources/read", { uri: catalog.find(x => x.name === "grill_show")._meta.ui.resourceUri })).contents[0].text;
  const script = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
    import {AppBridge,PostMessageTransport,isToolVisibilityModelOnly} from '@modelcontextprotocol/ext-apps/app-bridge';
    const frame=document.querySelector('iframe'),catalog=await(await fetch('/catalog')).json(),sizes=[];
    const zero={top:0,right:0,bottom:0,left:0};
    let context={containerDimensions:{maxHeight:1000,width:390},displayMode:'inline',availableDisplayModes:['inline','fullscreen'],safeAreaInsets:zero};
    const bridge=new AppBridge(null,{name:'Controlled sizing host',version:'1'},{serverTools:{}},{hostContext:context});
    bridge.oncalltool=async p=>{if(!catalog.some(t=>t.name===p.name&&!isToolVisibilityModelOnly(t)))throw Error('Visibility denied');return(await fetch('/tool',{method:'POST',body:JSON.stringify(p)})).json();};
    bridge.onsizechange=({height})=>{sizes.push({mode:context.displayMode,height});if(context.displayMode==='inline')frame.style.height=height+'px';};
    const update=(delta,height)=>{context={...context,...delta};if(height!==undefined)frame.style.height=height+'px';document.getElementById('chrome').hidden=context.displayMode!=='fullscreen';bridge.setHostContext(context);};
    bridge.onrequestdisplaymode=async({mode})=>{update({displayMode:mode,containerDimensions:{height:844,width:390},safeAreaInsets:{top:24,right:12,bottom:96,left:12}},844);return{mode};};
    bridge.oninitialized=async()=>{await bridge.sendToolResult(await(await fetch('/shown')).json());window.ready=true;};
    window.test={bridge,sizes,update,feedback:async()=>{for(let i=0;i<4;i++)await bridge.sendHostContextChange({containerDimensions:context.containerDimensions});},returnInline:()=>update({displayMode:'inline',safeAreaInsets:zero})};
    await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/view';
  ` }, bundle: true, write: false, format: "esm", platform: "browser" }).outputFiles[0].text;
  host = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      res.setHeader("cache-control", "no-store");
      if (req.url === "/") { res.setHeader("content-type", "text/html"); return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}iframe{display:block;width:390px;height:150px;border:0}#chrome{position:fixed;bottom:0;height:96px;width:100%;background:#ddd;z-index:2}</style><iframe sandbox="allow-scripts"></iframe><aside id="chrome" hidden>Controlled host overlay</aside><script type="module" src="/host.js"></script>'); }
      if (req.url === "/host.js") { res.setHeader("content-type", "text/javascript"); return res.end(script); }
      if (req.url === "/view") { res.setHeader("content-type", "text/html"); res.setHeader("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"); return res.end(resource); }
      res.setHeader("content-type", "application/json");
      if (req.url === "/catalog") return res.end(JSON.stringify(catalog));
      if (req.url === "/shown") return res.end(JSON.stringify(shown));
      if (req.url === "/tool") return res.end(JSON.stringify(await rpc("tools/call", body)));
      res.writeHead(404); res.end();
    } catch (e) { errors.push(e.message); res.writeHead(500); res.end(); }
  });
  await new Promise(r => host.listen(0, "127.0.0.1", r));
  browser = await chromium.launch({ headless: true, executablePath: process.env.GRILL_ME_CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${host.address().port}`); await page.waitForFunction(() => window.ready);
  const frame = page.frames().find(f => f.url().endsWith("/view")); await frame.locator(".gm-card").waitFor();
  const settle = () => frame.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const capture = async name => {
    if (!process.env.GRILL_ME_APPS_SIZING_EVIDENCE) return;
    await fs.mkdir(process.env.GRILL_ME_APPS_SIZING_EVIDENCE, { recursive: true });
    await page.screenshot({ path: path.join(process.env.GRILL_ME_APPS_SIZING_EVIDENCE, name + '.png') });
  };
  const measure = async label => {
    await settle();
    const geometry = await frame.evaluate(() => {
      const rect = selector => { const e = document.querySelector(selector); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
      return { viewport: innerHeight, width: document.documentElement.scrollWidth, host: rect('#app-host'), bar: rect('.gm-bar'), card: rect('.gm-card'), next: rect('.gm-row button:last-child'), input: rect('textarea'), draft: document.querySelector('textarea')?.value };
    });
    const outer = await page.evaluate(() => ({ frameHeight: document.querySelector('iframe').getBoundingClientRect().height, documentHeight: document.documentElement.scrollHeight, requests: window.test.sizes.slice() }));
    const record = { label, ...geometry, ...outer }; measurements.push(record); return record;
  };
  const initial = await measure("initial-soft-max1000");
  await page.evaluate(() => window.test.feedback()); const feedback = await measure("same-constraint-feedback");
  const originalMount = await frame.locator('#grill-root').elementHandle();
  await page.evaluate(() => window.test.update({ containerDimensions: { height: 150, width: 390 } }, 150));
  await frame.locator('#compact').waitFor({ timeout: 2000 });
  const minimized = await measure("fixed150-readable-fallback");
  assert.equal(minimized.host.height, 150); assert.equal(minimized.frameHeight, 150);
  assert.match(await frame.locator('#compact-title').textContent(), /Round 1 · Host sizing fixture/);
  assert.match(await frame.locator('#compact-copy').textContent(), /Full screen/);
  assert.ok(!await frame.locator('.gm-bar').isVisible(), "fixed150 does not expose unusable answer buttons");
  const expand = await frame.locator('#expand').boundingBox(); assert.ok(expand.y >= 0 && expand.y + expand.height <= 150);
  const compactTitle = await frame.locator('#compact-title').boundingBox(); assert.ok(compactTitle.y >= 0 && compactTitle.y + compactTitle.height <= expand.y);
  await capture('fixed150-compact');
  await page.evaluate(() => window.test.update({ availableDisplayModes: ['inline'] }));
  assert.match(await frame.locator('#compact-copy').textContent(), /same phone link/);
  await page.evaluate(() => window.test.update({ availableDisplayModes: ['inline', 'fullscreen'] }));
  await page.evaluate(() => window.test.update({ containerDimensions: { height: 350, width: 390 } }, 350)); await settle();
  await frame.locator(".gm-no").click({ timeout: 2000 }); await frame.locator("textarea").fill("Draft survives mode changes", { timeout: 2000 });
  const fixed = await measure("fixed350-own-draft");
  await page.evaluate(() => window.test.update({ containerDimensions: { height: 150, width: 390 } }, 150));
  assert.equal(await originalMount.evaluate(node => node === document.getElementById('grill-root')), true);
  assert.equal(await frame.locator('textarea').inputValue(), "Draft survives mode changes");
  await page.evaluate(() => window.test.update({ containerDimensions: { height: 350, width: 390 } }, 350));
  await frame.locator('textarea').waitFor({ state: 'visible', timeout: 2000 });
  await page.evaluate(() => window.test.update({ containerDimensions: { maxHeight: 1000, width: 390 } }, 480));
  await measure("compact-before-fullscreen");
  await frame.getByRole("button", { name: "Full screen", exact: true }).click();
  await frame.waitForFunction(() => document.documentElement.style.getPropertyValue('--host-height') === '844px');
  const full = await measure("fullscreen844-insets24-12-96-12");
  await capture('fullscreen-safe-insets');
  await page.evaluate(() => window.test.returnInline()); const returned = await measure("mode-only-return-inline");
  await page.evaluate(() => window.test.update({ theme: 'dark' }));
  assert.equal((await measure("partial-theme-no-resize")).requests.length, returned.requests.length);
  t.diagnostic(JSON.stringify({ scope: "Controlled official AppBridge only, not actual ChatGPT chrome", measurements, errors }));
  if (process.env.GRILL_ME_APPS_SIZING_EVIDENCE) {
    const out = process.env.GRILL_ME_APPS_SIZING_EVIDENCE; await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, "sizing.json"), JSON.stringify({ measurements, errors }, null, 2));
    await page.screenshot({ path: path.join(out, "returned-inline.png") });
  }
  assert.equal(initial.requests[0]?.height, 480, "maximum is a ceiling, not the preferred inline height");
  assert.equal(initial.frameHeight, 480); assert.ok(initial.documentHeight <= 844);
  assert.equal(feedback.requests.length, initial.requests.length, "unchanged soft bound cannot trigger a resize feedback loop");
  assert.equal(fixed.frameHeight, 350); assert.equal(fixed.host.height, 350);
  for (const state of [fixed, full, returned]) {
    assert.equal(state.draft, "Draft survives mode changes"); assert.equal(state.width, 390);
    assert.ok(state.input.bottom <= state.next.top); assert.ok(state.next.bottom <= state.card.bottom); assert.ok(state.next.bottom < state.bar.top);
  }
  assert.ok(full.bar.bottom <= 844 - 96, "host-provided fullscreen bottom overlay cannot obscure controls");
  assert.ok(full.card.top >= 24 && full.host.height === 844);
  assert.equal(returned.frameHeight, 480, "mode-only return requests saved compact inline size despite prior identical hint");
  assert.equal(returned.host.height, 480); assert.ok(returned.documentHeight <= 844);
  assert.deepEqual(errors, []);
});
