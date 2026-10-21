import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildSync } from 'esbuild';
import { createServer } from '../src/server.js';

test('official AppBridge resume: rejected/accepted wake retains answers, current draft copies, same-view collection clears recovery', {
  skip: !process.env.GRILL_ME_APPS_BROWSER, timeout: 30_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || 'playwright-core');
  const srv = createServer({ db: ':memory:', log: () => {} });
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  let sequence = 0, browser, host, rejectResume = true;
  const errors = [], messages = [];
  t.after(async () => { await browser?.close(); host?.closeAllConnections(); if (host?.listening) await new Promise(r => host.close(r)); srv.server.closeAllConnections(); await srv.close(); });
  const rpc = async (method, params = {}) => {
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) });
    const text = await response.text();
    return JSON.parse(text.startsWith(':') ? text.split('\n').find(l => l.startsWith('data: ')).slice(6) : text).result;
  };
  const call = async (name, args = {}) => { const value = await rpc('tools/call', { name, arguments: args }); assert.ok(!value.isError, value.content?.[0]?.text); return value.structuredContent; };
  const grill = { v: 1, questions: [{ n: 9, title: 'Recover in the SAME chat', recommend: { why: 'No replacement or implicit ACK' } }] };
  const { link } = await call('grill_start');
  await call('grill_send', { link, round: 1, expectedRevision: 0, grill });
  const shown = await rpc('tools/call', { name: 'grill_show', arguments: { link } });
  const catalog = (await rpc('tools/list')).tools;
  const resource = (await rpc('resources/read', { uri: catalog.find(t => t.name === 'grill_show')._meta.ui.resourceUri })).contents[0].text;
  const script = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
    import {AppBridge,PostMessageTransport,isToolVisibilityModelOnly} from '@modelcontextprotocol/ext-apps/app-bridge';
    const f=document.querySelector('iframe'),catalog=await(await fetch('/catalog')).json();
    const bridge=new AppBridge(null,{name:'Scripted resume host',version:'1'},{serverTools:{},message:{text:{}}},{hostContext:{containerDimensions:{height:350,width:390},displayMode:'inline'}});
    bridge.oncalltool=async p=>{if(!catalog.some(t=>t.name===p.name&&!isToolVisibilityModelOnly(t)))throw Error('Visibility denied');return(await fetch('/tool',{method:'POST',body:JSON.stringify(p)})).json();};
    bridge.onmessage=async p=>(await fetch('/message',{method:'POST',body:JSON.stringify(p)})).json();
    bridge.oninitialized=async()=>{await bridge.sendToolResult(await(await fetch('/shown')).json());window.ready=true;};
    await bridge.connect(new PostMessageTransport(f.contentWindow,f.contentWindow));f.src='/view';
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;
  host = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{border:0;width:390px;height:350px}</style><iframe sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script>'); }
      if (req.url === '/host.js') { res.setHeader('content-type', 'text/javascript'); return res.end(script); }
      if (req.url === '/view') { res.setHeader('content-type', 'text/html'); res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"); return res.end(resource); }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/catalog') return res.end(JSON.stringify(catalog));
      if (req.url === '/shown') return res.end(JSON.stringify(shown));
      if (req.url === '/tool') return res.end(JSON.stringify(await rpc('tools/call', body)));
      if (req.url === '/message') {
        messages.push(body);
        const resume = body.content[0].text.startsWith('Resume Grill Me');
        if (resume && rejectResume) { rejectResume = false; return res.end(JSON.stringify({ isError: true })); }
        return res.end('{}'); // acceptance is deliberately NOT collection/model execution
      }
      res.writeHead(404); res.end();
    } catch (e) { errors.push(e.message); res.writeHead(500); res.end(); }
  });
  await new Promise(r => host.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, executablePath: process.env.GRILL_ME_CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 390, height: 350 }, isMobile: true, hasTouch: true });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${host.address().port}`); await page.waitForFunction(() => window.ready);
  const frame = page.frames().find(f => f.url().endsWith('/view'));
  await frame.locator('.gm-no').click();
  await frame.locator('.gm-text textarea').fill('Uncommitted recovery draft');
  await frame.locator('#recovery-open').click();
  assert.match(await frame.locator('#recovery-help').textContent(), /15-second.*1-second.*30 seconds/s);
  await frame.locator('#recovery-copy').click();
  // Opaque sandbox has no clipboard privilege: selected manual fallback is real, no fake Copied.
  assert.equal(await frame.locator('#recovery-manual').textContent(), 'Q9 - Uncommitted recovery draft');
  await frame.locator('#resume-interview').click();
  await frame.locator('#recovery-state').filter({ hasText: 'Resume was not confirmed' }).waitFor();
  assert.equal((await call('grill_ui_state', { link })).snapshot.state, 'pending');
  await frame.locator('#resume-interview').click();
  await frame.locator('#recovery-state').filter({ hasText: 'accepted by the host' }).waitFor();
  await frame.locator('#recovery-close').click();
  assert.equal(await frame.locator('.gm-text textarea').inputValue(), 'Uncommitted recovery draft');
  await frame.locator('.gm-text .gm-primary').click();
  await frame.locator('.gm-send').click();
  await frame.locator('#status').filter({ hasText: 'Sent.' }).waitFor();
  assert.equal((await call('grill_ui_state', { link })).snapshot.state, 'answered');
  await frame.locator('#recovery-open').click(); await frame.locator('#recovery-copy').click();
  assert.equal(await frame.locator('#recovery-manual').textContent(), 'Q9 - Uncommitted recovery draft');
  await frame.locator('#resume-interview').click();
  await frame.locator('#recovery-state').filter({ hasText: 'accepted by the host' }).waitFor();
  assert.equal((await call('grill_ui_state', { link })).snapshot.state, 'answered', 'neither accepted notification nor accepted resume ACKs');
  assert.ok(messages.every(m => !m.content[0].text.includes('Uncommitted recovery draft') && !m.content[0].text.includes('#')), 'wake is metadata only');
  const answers = await call('grill_wait', { link, round: 1, seconds: 1 });
  assert.equal(answers.answers, 'Q9 - Uncommitted recovery draft'); // scripted host retains before ACK
  const ack = await call('grill_ack', { link, receipt: answers.receipt });
  await frame.locator('#recovery-copy[hidden]').waitFor({ state: 'attached' });
  assert.equal(await frame.locator('#recovery-manual').textContent(), '');
  await call('grill_send', { link, round: 2, expectedRevision: ack.revision, grill });
  await frame.locator('#recovery-close').click(); await frame.locator('.gm-card').waitFor();
  assert.equal(page.frames().find(f => f.url().endsWith('/view')), frame);
  await call('grill_cancel', { link });
  assert.deepEqual(errors, []);
});
