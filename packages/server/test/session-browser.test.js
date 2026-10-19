import {test} from 'node:test';import {fileURLToPath} from 'node:url';
import {createServer} from '../../server/src/server.js';
import {send,sendRound,wait,finish,cancel} from '../../cli/src/index.js';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import http from 'node:http';import cp from 'node:child_process';import assert from 'node:assert/strict';
import { readPending } from '../../cli/src/pending.js';
import { deriveSessionKeys, sealRoundAnswers } from '../../core/src/session.js';
import { newId } from '../../core/src/crypto.js';
test('actual touch, same-link rounds, current draft and warm 0.1 browser cache', {skip: !process.env.GRILL_ME_BROWSER_TEST, timeout:60000}, async(t)=>{
const {chromium}=await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || 'playwright-core');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),pin='d1fb2110565426ca450f57ea215cf92e7cd60b92';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'gm256-browser-'));
let srv,proxy,browser;
t.after(async()=>{await browser?.close();if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r))}if(srv)await srv.close();await fs.rm(home,{recursive:true,force:true})});
srv=createServer();await new Promise(r=>srv.server.listen(0,'127.0.0.1',r));
const upstream=srv.server.address().port;
let phase=1, apiOffline=false;const requests=[];
const frozen=new Map();
for(const f of cp.execFileSync('git',['ls-tree','-r','--name-only',pin,'packages/server/public','packages/core/src','packages/ui/src'],{cwd:repo,encoding:'utf8'}).trim().split('\n')) {
 const url=f.startsWith('packages/core/src/')?'/core/'+f.slice(18):f.startsWith('packages/ui/src/')?'/ui/'+f.slice(16):'/'+f.slice(23);
 frozen.set(url,cp.execFileSync('git',['show',pin+':'+f],{cwd:repo}));
}
proxy=http.createServer((req,res)=>{
 const p=new URL(req.url,'http://test').pathname;requests.push({phase,path:p});
 if(apiOffline && p.startsWith('/api/')) return res.destroy();
 if(phase===1&&!p.startsWith('/api/')) {
   const body=frozen.get(p.startsWith('/g/')?'/grill.html':p);
   if(!body){res.writeHead(404);return res.end()}
   res.writeHead(200,{'content-type':p.startsWith('/g/')?'text/html':p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'image/svg+xml','cache-control':p.startsWith('/g/')?'no-store':'public,max-age=300'});return res.end(body);
 }
 const pReq=http.request({host:'127.0.0.1',port:upstream,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});pReq.on('error',()=>res.destroy());res.on('close',()=>pReq.destroy());req.pipe(pReq);
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const opts={home,server:`http://127.0.0.1:${proxy.address().port}`};
browser=await chromium.launch({headless:true,...(process.env.GRILL_ME_BROWSER_EXECUTABLE ? {executablePath:process.env.GRILL_ME_BROWSER_EXECUTABLE}: {})});
const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
const grill={v:1,questions:[{n:1,title:'Disposable round',body:'Same questions in both rounds.',recommend:{why:'Test'}}]};
const swipe=async(dx)=>{const b=await page.locator('.gm-card').boundingBox(),x=b.x+b.width/2,y=b.y+100;const c=await context.newCDPSession(page);await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let i=1;i<=6;i++)await c.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/6,y}]});await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await c.detach();};
const legacy=await send(grill,opts);await page.goto(legacy.link);await page.locator('.gm-card').waitFor();await cancel(legacy.id,opts);
 phase=2;
 const one=await sendRound(grill,opts);await page.goto(one.link);await page.locator('.gm-card').waitFor();
 assert.equal(new URL(page.url()).search,'?session=2');assert.equal(new URL(page.url()).hash,'');
 await swipe(160);await page.locator('.gm-send').waitFor();await page.locator('.gm-send').click();await page.locator('#screen-done:not([hidden])').waitFor();
 assert.equal(await page.evaluate(()=>Object.entries(localStorage).some(([k,v])=>k.startsWith('gm:s2:')&&v.includes('Same questions in both rounds.'))),false);
 await page.reload();await page.locator('#screen-done:not([hidden])').waitFor();
 const first=await wait(one.id,{...opts,seconds:2});assert.equal(first.lines,'Q1 - agree');await first.ack();
 await page.locator('#screen-message:not([hidden])').waitFor();
 const two=await sendRound(grill,{...opts,id:one.id,round:2});assert.equal(two.link,one.link);
 await page.locator('.gm-card').waitFor();assert.equal(await page.locator('.gm-send').count(),0);
 await swipe(-160);await page.locator('textarea').waitFor();await page.locator('textarea').fill('Current round draft');
 await page.reload();await page.locator('.gm-card').waitFor();await swipe(-160);await page.locator('textarea').waitFor();assert.equal(await page.locator('textarea').inputValue(),'Current round draft');
 await page.setViewportSize({width:390,height:350});
 const bounds=await page.evaluate(()=>{const a=document.querySelector('.gm-text .gm-primary').getBoundingClientRect(),b=document.querySelector('.gm-card').getBoundingClientRect(),c=document.querySelector('.gm-bar').getBoundingClientRect();return {next:a.bottom,card:b.bottom,bar:c.top}});assert.ok(bounds.next<=bounds.card&&bounds.next<bounds.bar);
 await page.locator('.gm-text .gm-primary').click();await page.locator('.gm-send').click();await page.locator('#screen-done:not([hidden])').waitFor();
 const second=await wait(one.id,{...opts,seconds:2});assert.equal(second.lines,'Q1 - Current round draft');await second.ack();
 await finish(one.id,opts);await page.locator('#message-text').filter({hasText:'Session ended or expired.'}).waitFor();
 assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('gm:s2:')).length),0);
 assert.ok(requests.some(r=>r.phase===1&&r.path==='/app.js'));assert.ok(requests.some(r=>r.phase===1&&r.path==='/core/index.js'));
 for(const p of ['/entry-020.js','/session-app.js','/core/session.js'])assert.ok(requests.some(r=>r.phase===2&&r.path===p),p);
 // Static pages still load while the API is unreachable. Current draft survives reload;
 // an ambiguous submission cannot silently send a later edited answer under the old intent.
 await page.setViewportSize({width:390,height:844});
 const offline=await sendRound(grill,opts);
 await page.goto(offline.link);await page.locator('.gm-card').waitFor();
 await swipe(-160);await page.locator('textarea').fill('Original offline draft');
 apiOffline=true;
 await page.reload();await page.locator('.gm-card').waitFor();await swipe(-160);
 assert.equal(await page.locator('textarea').inputValue(),'Original offline draft');
 await page.locator('.gm-text .gm-primary').click();await page.locator('.gm-send').click();
 await page.locator('.gm-note').filter({hasText:'earlier submission may have arrived'}).waitFor();
 await page.locator('.gm-qrow').click();await swipe(-160);
 await page.locator('textarea').fill('Different later draft');
 await page.locator('.gm-text .gm-primary').click();await page.locator('.gm-send').click();
 await page.locator('.gm-note').filter({hasText:'earlier submission is unconfirmed'}).waitFor();
 apiOffline=false;
 await page.reload();await page.locator('.gm-send').waitFor();await page.locator('.gm-send').click();
 await page.locator('#screen-done:not([hidden])').waitFor();
 const recovered=await wait(offline.id,{...opts,seconds:2});
 assert.equal(recovered.lines,'Q1 - Original offline draft');await recovered.ack();
 await finish(offline.id,opts);await page.locator('#message-text').filter({hasText:'Session ended or expired.'}).waitFor();

 // A different device winning must not turn the losing draft into a sent claim, even on reload.
 const losing=await sendRound(grill,opts);
 await page.goto(losing.link);await page.locator('.gm-card').waitFor();
 await swipe(-160);await page.locator('textarea').fill('Losing device draft');
 await page.locator('.gm-text .gm-primary').click();
 const rec=await readPending(home,losing.id),keys=await deriveSessionKeys(rec.secret);
 const blob=await sealRoundAnswers({v:1,answers:[{n:1,kind:'agree'}]},rec.grill,{id:rec.id,secret:rec.secret,round:1});
 const won=await fetch(`${opts.server}/api/s/${rec.id}/rounds/1/answers`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${keys.writeToken}`},body:JSON.stringify({expectedRevision:1,submissionId:newId(),...blob})});
 assert.equal(won.status,204);
 await page.locator('.gm-note').filter({hasText:'Another device answered'}).waitFor();
 await page.reload();await page.locator('.gm-note').filter({hasText:'Another device answered'}).waitFor();
 assert.equal(await page.locator('#screen-done').isVisible(),false);
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await page.locator('#copy-answers').click();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'Q1 - Losing device draft');
 const winner=await wait(losing.id,{...opts,seconds:2});assert.equal(winner.lines,'Q1 - agree');await winner.ack();
 await page.locator('#screen-message:not([hidden])').waitFor();
 assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('gm:s2:r:')).length),0);
 await finish(losing.id,opts);await page.locator('#message-text').filter({hasText:'Session ended or expired.'}).waitFor();
 // Same-browser tabs share current-only storage. A retained old textarea callback must
 // not repopulate round 1 after another tab observes the next round or session end.
 const twins=await sendRound(grill,opts);
 await page.goto(twins.link);await page.locator('.gm-card').waitFor();
 const other=await context.newPage();other.on('pageerror',e=>errors.push(String(e)));
 await other.goto(twins.link);await other.locator('.gm-card').waitFor();
 await other.locator('.gm-no').click();await other.locator('textarea').fill('Old tab draft');
 await other.evaluate(()=>{globalThis.oldInput=document.querySelector('textarea')});
 await swipe(160);await page.locator('.gm-send').waitFor();await page.locator('.gm-send').click();
 await page.locator('#screen-done:not([hidden])').waitFor();
 const twinAnswers=await wait(twins.id,{...opts,seconds:2});await twinAnswers.ack();
 await sendRound(grill,{...opts,id:twins.id,round:2});
 await other.waitForFunction(id=>!!localStorage.getItem(`gm:s2:r:${id}:2`),twins.id);
 await other.locator('.gm-card').waitFor();
 await other.evaluate(()=>{oldInput.value='late old input';oldInput.dispatchEvent(new Event('input',{bubbles:true}))});
 assert.equal(await other.evaluate(id=>localStorage.getItem(`gm:s2:r:${id}:1`),twins.id),null);
 assert.equal(await other.locator('.gm-send').count(),0);
 await cancel(twins.id,opts);
 await page.locator('#message-text').filter({hasText:'Session ended or expired.'}).waitFor();
 await other.locator('#message-text').filter({hasText:'Session ended or expired.'}).waitFor();
 await other.close();
 // Deterministic late-work fault: hold an actual WebCrypto decrypt and delay only the
 // existing 200ms swipe-commit callback. Neither may recreate round 1 after round 2 mounts.
 await page.addInitScript(() => {
   const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
   let first = true;
   crypto.subtle.decrypt = async (...args) => {
     const value = await decrypt(...args);
     if (first) { first = false; globalThis.oldDecryptReady = true; await new Promise(r => { globalThis.releaseOldDecrypt = r; }); }
     return value;
   };
   const timer = setTimeout;
   globalThis.setTimeout = (fn, ms, ...args) => ms === 200
     ? timer(() => { globalThis.oldSwipeRan = true; fn(...args); }, 1000)
     : timer(fn, ms, ...args);
 });
 const late=await sendRound(grill,opts);
 await page.goto(late.link);await page.waitForFunction(()=>globalThis.oldDecryptReady===true);await page.locator('.gm-card').waitFor();
 await swipe(160);
 const lr=await readPending(home,late.id),lk=await deriveSessionKeys(lr.secret);
 const lb=await sealRoundAnswers({v:1,answers:[{n:1,kind:'agree'}]},lr.grill,{id:lr.id,secret:lr.secret,round:1});
 assert.equal((await fetch(`${opts.server}/api/s/${lr.id}/rounds/1/answers`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${lk.writeToken}`},body:JSON.stringify({expectedRevision:1,submissionId:newId(),...lb})})).status,204);
 const collected=await wait(late.id,{...opts,seconds:2});await collected.ack();
 await sendRound(grill,{...opts,id:late.id,round:2});
 await page.waitForFunction(id=>!!localStorage.getItem(`gm:s2:r:${id}:2`),late.id);
 await page.locator('.gm-card').waitFor();await page.evaluate(()=>globalThis.releaseOldDecrypt());
 await page.waitForFunction(()=>globalThis.oldSwipeRan===true);
 assert.equal(await page.evaluate(id=>localStorage.getItem(`gm:s2:r:${id}:1`),late.id),null);
 assert.equal(await page.locator('.gm-send').count(),0);
 assert.equal(await page.locator('.gm-card').isVisible(),true);
 await cancel(late.id,opts);await page.locator('#message-text').filter({hasText:'Session ended or expired.'}).waitFor();
 assert.deepEqual(errors,[]);
 assert.equal(requests.some(r=>r.phase===2&&['/app.js','/core/index.js','/core/crypto.js'].includes(r.path)),false,'unchanged legacy modules were actually reused from the warm cache');
 console.log(JSON.stringify({result:'PASS',warmSameOriginCache:true,cacheCleared:false,networkRoutesUsed:false,rounds:2,stableLink:true,actualTouch:['right-agree','left-own'],reloadDraft:true,short350:bounds,finishPurge:true,offlineApiReload:true,immutableSubmission:true,losingDeviceCopy:true,lateAsyncAndTabGuards:true,pageerrors:errors,requests},null,2));


});
