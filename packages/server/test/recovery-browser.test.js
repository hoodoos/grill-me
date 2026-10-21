import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { sendRound, wait, cancel } from '../../cli/src/index.js';

// Target journeys with a real browser, relay, encryption, saved intent and collection.
// Clock is advanced only on the relay to exercise its real one-hour expiry without waiting an hour.
test('phone timeout recovery: submitted copy survives reload, ACK purges, expired current draft copies without resurrecting storage', {
  skip: !process.env.GRILL_ME_BROWSER_TEST, timeout: 30_000,
}, async t => {
  const { chromium } = await import(process.env.GRILL_ME_PLAYWRIGHT_MODULE || 'playwright-core');
  let now = Date.now();
  const srv = createServer({ db: ':memory:', now: () => now, sweepMs: 20, log: () => {} });
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gm-recovery-'));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.GRILL_ME_BROWSER_EXECUTABLE });
  t.after(async () => { await browser.close(); srv.server.closeAllConnections(); await srv.close(); await fs.rm(home, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 390, height: 350 }, isMobile: true, hasTouch: true,
    permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const opts = { home, server: base };
  const grill = { v: 1, questions: [{ n: 7, title: 'Recover this decision', recommend: { why: 'Keep current-only answers' } }] };
  const first = await sendRound(grill, opts);
  await page.goto(first.link);
  await page.locator('.gm-no').click();
  await page.locator('textarea').fill('Current phone answer');
  // Recovery is a modal, not another scrolling card footer. It cannot discard a draft.
  await page.locator('section:not([hidden]) > [data-recovery], section:not([hidden]) [data-recovery]').click();
  await page.getByText('Hosted phone waits: 45 seconds per call', { exact: false }).waitFor();
  assert.match(await page.locator('#recovery-expiry').textContent(), /Opening or polling.*does not extend/);
  await page.locator('#copy-resume').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Resume Grill Me for interview/);
  await page.emulateMedia({ colorScheme: 'dark' });
  const colors = await page.locator('#recovery-dialog').evaluate(el => ({ ink: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
  assert.notEqual(colors.ink, colors.bg);
  assert.equal(colors.ink, 'rgb(230, 233, 237)', 'recovery text follows actual dark-theme foreground');
  if (process.env.GRILL_ME_BROWSER_EVIDENCE) await page.screenshot({ path: path.join(process.env.GRILL_ME_BROWSER_EVIDENCE, 'recovery-dark-390x350.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  if (process.env.GRILL_ME_BROWSER_EVIDENCE) await page.screenshot({ path: path.join(process.env.GRILL_ME_BROWSER_EVIDENCE, 'recovery-light-390x350.png') });
  const rect = await page.locator('#recovery-dialog').boundingBox();
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 390 && rect.y + rect.height <= 350);
  await page.locator('#recovery-close').click();
  assert.equal(await page.locator('.gm-text textarea').inputValue(), 'Current phone answer');
  await page.locator('.gm-text .gm-primary').click();
  await page.locator('.gm-send').click();
  await page.locator('#screen-done:not([hidden])').waitFor();
  assert.match(await page.locator('#done-text').textContent(), /Resume Grill Me/);
  assert.equal((await (await fetch(base + '/api/s/' + first.id)).json()).state, 'answered');
  await page.reload();
  await page.locator('#screen-done:not([hidden])').waitFor();
  await page.locator('#done-copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Q7 - Current phone answer');
  const stored = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('gm:s2:r:')).map(([, v]) => JSON.parse(v)));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].grill, null); assert.equal(stored[0].snap, null);
  assert.ok(stored[0].roundBlob.ct && stored[0].intent.ct, 'copy uses current encrypted question+intent, no retained submitted plaintext');
  assert.ok(!JSON.stringify(stored).includes('Current phone answer'));
  const answer = await wait(first.id, { ...opts, seconds: 5 });
  assert.equal(answer.lines, 'Q7 - Current phone answer');
  await answer.ack();
  await page.locator('#thinking-stack').waitFor();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('gm:s2:r:')).length), 0);
  await page.locator('section:not([hidden]) > [data-recovery], section:not([hidden]) [data-recovery]').click();
  assert.equal(await page.locator('#recovery-copy').isVisible(), false, 'collection removes recovery copy');
  await page.locator('#recovery-close').click();
  await cancel(first.id, opts);

  const second = await sendRound(grill, opts);
  await page.goto(second.link); await page.locator('.gm-no').click();
  await page.locator('.gm-text textarea').fill('Unsent before expiry');
  await page.locator('.gm-text .gm-primary').click();
  // Reload after the relay expires. Stored current draft is captured into this document
  // before storage/key purge; it never recreates a row or a history entry.
  now += 3_600_001;
  await page.reload();
  await page.locator('#message-text').filter({ hasText: 'Resume Grill Me' }).waitFor();
  assert.equal((await fetch(base + '/api/s/' + second.id)).status, 404);
  await page.locator('section:not([hidden]) > [data-recovery], section:not([hidden]) [data-recovery]').click();
  await page.locator('#recovery-copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Q7 - Unsent before expiry');
  assert.equal(await page.evaluate(id => Object.keys(localStorage).filter(k => k.startsWith('gm:s2:') && k.includes(id)).length, second.id), 0);
  assert.match(await page.locator('#recovery-state').textContent(), /Copied/);
  await page.locator('#recovery-close').click();
  await page.reload();
  await page.locator('#message-text').filter({ hasText: 'Resume Grill Me' }).waitFor();
  await page.locator('section:not([hidden]) > [data-recovery], section:not([hidden]) [data-recovery]').click();
  assert.equal(await page.locator('#recovery-copy').isVisible(), false, 'expired copy is memory-only, gone after close/reload');
  await page.locator('#recovery-close').click();
  // Hours-old submitted link: only current encrypted intent is persisted. Its recovery
  // copy is decrypted into the open expiry page, with key/storage immediately erased.
  const third = await sendRound(grill, opts);
  await page.goto(third.link); await page.locator('.gm-yes').click(); await page.locator('.gm-send').click();
  await page.locator('#screen-done:not([hidden])').waitFor();
  now += 3_600_001;
  await page.reload(); await page.locator('#message-text').filter({ hasText: 'Resume Grill Me' }).waitFor();
  await page.locator('section:not([hidden]) [data-recovery]').click();
  await page.locator('#recovery-copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Q7 - agree');
  assert.equal(await page.evaluate(id => Object.keys(localStorage).filter(k => k.includes(id)).length, third.id), 0);
  assert.deepEqual(errors, []);
});
