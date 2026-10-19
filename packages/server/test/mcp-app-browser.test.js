import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { buildSync } from "esbuild";
import { createServer } from "../src/server.js";
import { parseSessionLink, sealRoundAnswers } from "../../core/src/session.js";
import { newId } from "../../core/src/crypto.js";

test("official AppBridge opaque sandbox: completed result, real swipes, exact lost submit, rejected message retry, two rounds and explicit ACK", {
  skip: !process.env.GRILL_ME_APPS_BROWSER, timeout: 45_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || "playwright-core");
  const srv = createServer({ db: ":memory:", log: () => {} });
  await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const errors = [], calls = [], messages = [], requests = [];
  let browser, host, sequence = 0, context, lost = true, releaseAgent, lossMode = false, noMessage = false, collectMessages = true;
  const agentGate = new Promise(resolve => { releaseAgent = resolve; });
  const retained = [], hostFailures = [];
  t.after(async () => { await browser?.close(); host?.closeAllConnections(); if (host?.listening) await new Promise(r => host.close(r)); srv.server.closeAllConnections(); await srv.close(); });
  const rpc = async (method, params = {}) => {
    const r = await fetch(base + "/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }) });
    const text = await r.text(); return JSON.parse(text.startsWith(":") ? text.split("\n").find(l => l.startsWith("data: ")).slice(6) : text).result;
  };
  const call = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); assert.ok(!r.isError); return r; };
  const grill = { v: 1, questions: [{ n: 1, title: "Inline frontier", body: "Swipe these actual shared cards.", recommend: { why: "Disposable recommendation" } }] };
  const prepared = (await call("grill_start")).structuredContent;
  let link = prepared.link, ids = parseSessionLink(link);
  await call("grill_send", { link, round: 1, expectedRevision: 0, grill });
  context = await call("grill_show", { link });
  const catalog = (await rpc("tools/list")).tools;
  const uri = catalog.find(t => t.name === "grill_show")._meta.ui.resourceUri;
  const resource = (await rpc("resources/read", { uri })).contents[0].text;
  // A scripted host turn triggered by ui/message, not an account/model claim. It owns
  // history outside the relay, reads/retains BEFORE ACK, then sends the next frontier.
  const continueFromMessage = async body => {
    await agentGate;
    const round = Number(/round (\d+),/.exec(body.content[0].text)[1]);
    const result = (await call("grill_wait", { link, round, seconds: 1 })).structuredContent;
    assert.equal(result.status, "ANSWERS"); retained.push(result);
    const ack = (await call("grill_ack", { link, receipt: result.receipt })).structuredContent;
    if (round === 1) await call("grill_send", { link, round: 2, expectedRevision: ack.revision, grill });
    else await call("grill_finish", { link, expectedRevision: ack.revision });
  };
  const hostScript = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
    import { AppBridge, PostMessageTransport, isToolVisibilityModelOnly } from '@modelcontextprotocol/ext-apps/app-bridge';
    const frame = document.querySelector('iframe');
    const catalog = await (await fetch('/catalog')).json();
    const mode = await (await fetch('/mode')).json();
    const bridge = new AppBridge(null,{name:'Official isolated host',version:'1'}, {serverTools:{},...(mode.noMessage?{}:{message:{text:{}}})},
      {hostContext:{containerDimensions:{height:350,width:innerWidth},displayMode:'inline',availableDisplayModes:['inline','fullscreen']}});
    bridge.oncalltool = async params => {
      if (!catalog.some(t=>t.name===params.name && !isToolVisibilityModelOnly(t))) throw new Error('Visibility denied');
      const r = await fetch('/tool',{method:'POST',body:JSON.stringify(params)}); if(!r.ok) throw new Error('Lost relay reply'); return r.json();
    };
    bridge.onmessage = async params => (await fetch('/message',{method:'POST',body:JSON.stringify(params)})).json();
    bridge.onsizechange = ({height}) => { if (Number.isFinite(height)) frame.style.height=height+'px'; };
    bridge.onrequestdisplaymode = async ({mode}) => { bridge.setHostContext({containerDimensions:{height:350,width:390},displayMode:mode,availableDisplayModes:['inline','fullscreen']}); return {mode}; };
    bridge.oninitialized = async () => { window.ready=true; await bridge.sendToolInput({arguments:{link:'never-mount-input'}}); };
    await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));
    window.test={bridge,frame,send:async()=>bridge.sendToolResult(await(await fetch('/context')).json()),resize:(height,max=false)=>{frame.style.height=height+'px';bridge.setHostContext({containerDimensions:max?{maxHeight:height,width:innerWidth}:{height,width:innerWidth},displayMode:'inline',availableDisplayModes:['inline','fullscreen']});}};
    frame.src='/view';
  ` }, bundle: true, write: false, platform: "browser", target: "es2022", format: "esm" }).outputFiles[0].text;
  host = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      res.setHeader("cache-control", "no-store");
      if (req.url === "/") { res.setHeader("content-type", "text/html"); return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;overflow:hidden}iframe{border:0;width:100%;height:350px}</style><iframe sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script>'); }
      if (req.url === "/host.js") { res.setHeader("content-type", "text/javascript"); return res.end(hostScript); }
      if (req.url === "/view") { res.setHeader("content-type", "text/html"); res.setHeader("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'"); return res.end(resource); }
      res.setHeader("content-type", "application/json");
      if (req.url === "/catalog") return res.end(JSON.stringify(catalog));
      if (req.url === "/mode") return res.end(JSON.stringify({noMessage}));
      if (req.url === "/context") return res.end(JSON.stringify(context));
      if (req.url === "/message") {
        messages.push(body); const isError = messages.length === 1; res.end(JSON.stringify({ isError }));
        if (!isError && collectMessages) setImmediate(() => void continueFromMessage(body).catch(e => hostFailures.push(e.message)));
        return;
      }
      if (req.url === "/tool") {
        calls.push(body); const tool = catalog.find(t => t.name === body.name);
        assert.deepEqual(tool._meta.ui.visibility, ["app"], "host enforces catalog, never proxies model ACK");
        if (body.name === 'grill_ui_submit' && lossMode) {
          lossMode = false;
          const competing = { ...body.arguments, submissionId:newId(), ...await sealRoundAnswers({v:1,answers:[{n:1,kind:'own',text:'Different winning ciphertext'}]},grill,{...ids,round:1}) };
          await call('grill_ui_submit',competing);
        }
        const result = await rpc("tools/call", body);
        if (body.name === "grill_ui_submit" && lost) { lost = false; res.writeHead(503); return res.end("{}"); }
        return res.end(JSON.stringify(result));
      }
      res.writeHead(404); res.end();
    } catch (e) { errors.push(e.message); res.writeHead(500); res.end(); }
  });
  await new Promise(r => host.listen(0, "127.0.0.1", r));
  browser = await chromium.launch({ executablePath: process.env.GRILL_ME_CHROME_PATH, headless: true });
  let page = await browser.newPage({ viewport: { width: 390, height: 350 }, isMobile: true, hasTouch: true });
  page.on("pageerror", e => errors.push(e.message)); page.on("request", r => requests.push({ url: r.url(), frame: r.frame().url() }));
  await page.goto(`http://127.0.0.1:${host.address().port}/`);
  await page.waitForFunction(() => window.ready);
  let frame = page.frames().find(f => f.url().endsWith("/view")); assert.ok(frame);
  assert.equal(await frame.locator(".gm-card").count(), 0, "input never mounts");
  await page.evaluate(() => window.test.send());
  await frame.locator(".gm-card").waitFor();
  const forbidden = await frame.evaluate(() => new Promise(resolve => {
    const id = 'forbidden-ack'; const listener = event => { if (event.data?.id === id) { removeEventListener('message',listener); resolve(event.data); } };
    addEventListener('message',listener); parent.postMessage({jsonrpc:'2.0',id,method:'tools/call',params:{name:'grill_ack',arguments:{}}},'*');
  }));
  assert.ok(forbidden.error,"official bridge host rejects widget ACK before any relay invocation");
  await page.evaluate(() => window.test.send()); // repeated result cannot reset this round
  let cdp = await page.context().newCDPSession(page);
  const swipe = async dx => {
    const box = await frame.locator(".gm-card").boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 12; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * i / 12, y }] }); await new Promise(r => setTimeout(r, 18)); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe(-165); const textarea = frame.locator("textarea"); await textarea.waitFor(); await textarea.fill("Current draft only");
  await page.evaluate(() => window.test.send()); assert.equal(await textarea.inputValue(), "Current draft only");
  await page.evaluate(() => window.test.resize(350,true));
  const geometry = await frame.evaluate(() => {
    const r = s => { const { top,bottom }=document.querySelector(s).getBoundingClientRect(); return {top,bottom}; };
    return { input:r('textarea'),next:r('.gm-row button'),card:r('.gm-card'),bar:r('.gm-bar'),width:document.documentElement.scrollWidth };
  });
  assert.ok(geometry.input.bottom <= geometry.next.top); assert.ok(geometry.next.bottom <= geometry.card.bottom); assert.ok(geometry.next.bottom < geometry.bar.top); assert.equal(geometry.width,390);
  await frame.getByRole("button", { name: "Next", exact: true }).click();
  await frame.getByRole("button", { name: "Send answers", exact: true }).click();
  await frame.getByText("Sent. The host follow-up was not confirmed.", { exact: false }).waitFor();
  const submissions = calls.filter(c => c.name === "grill_ui_submit"); assert.ok(submissions.length >= 2); assert.deepEqual(submissions[0].arguments, submissions[1].arguments, "lost reply repeats exact sealed intent");
  assert.equal((await call("grill_ui_state", { link })).structuredContent.snapshot.state,"answered", "message rejection never ACKs");
  await frame.getByRole("button", { name: "Retry", exact: true }).click();
  await page.waitForFunction(async () => (await(await fetch('/context')).json()).structuredContent.status==='VIEW');
  for (let n=0;messages.length<2 && n<100;n++) await new Promise(r=>setTimeout(r,10));
  assert.equal(messages.length,2); assert.ok(Array.isArray(messages[0].content)); assert.ok(!JSON.stringify(messages).includes(ids.secret));
  releaseAgent(); // already queued by accepted message: no manual chat nudge/tool turn
  await frame.locator(".gm-card").waitFor(); assert.equal(await frame.locator("textarea").count(),0,"identical next questions start unanswered");
  assert.match(retained[0].answers,/Current draft only/);
  await swipe(165); await frame.getByRole("button",{name:"Send answers",exact:true}).click();
  await frame.getByText("All done—your agent has finished this grill.").waitFor();
  assert.equal(retained.length,2);assert.deepEqual(hostFailures,[]);assert.deepEqual(errors,[]);
  const acceptedMessages=messages.length;
  const reopen = async () => {
    link=(await call('grill_start')).structuredContent.link;ids=parseSessionLink(link);
    await call('grill_send',{link,round:1,expectedRevision:0,grill});context=await call('grill_show',{link});
    await page.reload();await page.waitForFunction(()=>window.ready);frame=page.frames().find(f=>f.url().endsWith('/view'));
    await page.evaluate(()=>window.test.send());await frame.locator('.gm-card').waitFor();
  };
  lossMode=true;collectMessages=false;await reopen();
  await frame.locator('.gm-yes').click();await frame.getByRole('button',{name:'Send answers',exact:true}).click();
  try { await frame.getByText('Another submission won this round.',{exact:false}).waitFor({timeout:5000}); }
  catch(e){t.diagnostic(JSON.stringify({stage:'competing-winner',lossMode,calls:calls.slice(-6).map(c=>({name:c.name,round:c.arguments?.round})),state:await frame.locator('#status').textContent(),errors}));throw e;}
  for(let n=0;messages.length===acceptedMessages&&n<100;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(messages.length,acceptedMessages+1,'loser may request collection of the actual server-confirmed winner, never its losing intent');
  const winning=(await call('grill_ui_state',{link})).structuredContent.snapshot;
  assert.ok(messages.at(-1).content[0].text.includes(winning.submissionId));
  assert.ok(!messages.at(-1).content[0].text.includes(calls.filter(c=>c.name==='grill_ui_submit').at(-1).arguments.submissionId));
  assert.match((await call('grill_wait',{link,round:1,seconds:1})).structuredContent.answers,/Different winning ciphertext/);
  await call('grill_cancel',{link});await frame.getByText('This grill was cancelled.').waitFor();
  noMessage=true;await reopen();
  await frame.locator('.gm-yes').click();await frame.getByRole('button',{name:'Send answers',exact:true}).click();
  await frame.getByText('Sent. This host cannot request an automatic follow-up here.',{exact:false}).waitFor();
  assert.equal((await call('grill_ui_state',{link})).structuredContent.snapshot.state,'answered');
  assert.equal(messages.length,acceptedMessages+1);assert.equal(await frame.getByRole('button',{name:'Retry',exact:true}).isVisible(),true);
  await call('grill_cancel',{link});await frame.getByText('This grill was cancelled.').waitFor();
  assert.deepEqual(errors,[]);
  assert.ok(!requests.some(r=>r.frame.endsWith('/view') && !r.url.endsWith('/view')),"sandbox makes no direct API/module requests");
  // A fresh desktop context avoids mixing a resized mobile-emulation target with
  // mouse/touch input. Mobile continuation above stays on the same untouched view.
  await page.close();page=await browser.newPage({viewport:{width:1280,height:800},hasTouch:true});
  cdp=await page.context().newCDPSession(page);await page.goto(`http://127.0.0.1:${host.address().port}/`);
  await reopen();await page.evaluate(()=>window.test.resize(800));
  for(const kind of ['touch','mouse']) for(const direction of [-1,1]) {
    await frame.waitForFunction(()=>document.getElementById('app-host').clientHeight===800 && getComputedStyle(document.querySelector('.gm-card')).transform==='none');
    const rest=await frame.locator('.gm-card').boundingBox(),x=rest.x+rest.width/2,y=rest.y+rest.height/2;
    if(kind==='touch') await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    else {await page.mouse.move(x,y);await page.mouse.down();}
    for(let i=1;i<=12;i++) {
      const px=x+direction*240*i/12;
      if(kind==='touch') await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:px,y}]});else await page.mouse.move(px,y);
      await new Promise(r=>setTimeout(r,18));
    }
    const paint=await frame.evaluate(({rest,direction})=>{
      const card=document.querySelector('.gm-card'),m=new DOMMatrix(getComputedStyle(card).transform),w=card.offsetWidth,h=card.offsetHeight;
      const px=rest.x+w/2+m.a*w*.40*direction+m.e,py=rest.y+h/2+m.b*w*.40*direction+m.f;
      return {x:px,painted:card.contains(document.elementFromPoint(px,py)),width:document.documentElement.scrollWidth};
    },{rest,direction});
    assert.ok(direction>0?paint.x>960&&paint.x<1280:paint.x>0&&paint.x<320,JSON.stringify(paint));assert.equal(paint.painted,true);assert.equal(paint.width,1280);
    if(process.env.GRILL_ME_APPS_EVIDENCE){await fs.mkdir(process.env.GRILL_ME_APPS_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.GRILL_ME_APPS_EVIDENCE,`inline-desktop-${kind}-${direction}.png`)});}
    // Return below threshold before release so this separate paint probe is not an
    // extra answer. It exercises real inputs without changing interview state.
    if(kind==='touch'){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
    else {await page.mouse.move(x,y);await page.mouse.up();}
  }
  await call('grill_cancel',{link});await frame.getByText('This grill was cancelled.').waitFor();
});
