// Execute the real page host with a small DOM/transport shell. Keep real crypto, storage and
// UI state; replace only mountGrill's rendering so these host regressions need no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as core from "../../core/src/index.js";
import { createState } from "../../ui/src/state.js";

const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/import \{([\s\S]*?)\} from "\/core\/index.js";/, "const {$1} = core;")
  .replace('import { mountGrill } from "/ui/grill.js";', "")
  .replace("else runGrill(id);", "else globalThis.ready = runGrill(id);");
const plain = (v) => JSON.parse(JSON.stringify(v));
const sample = () => core.convert(core.DEMO_TEXT).grill;

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
  };
}

async function transport(grill = sample()) {
  const ids = { id: core.newId(), secret: core.newSecret() };
  const blob = await core.sealGrill(grill, ids);
  const api = {
    ids, grill, present: true, answered: false, requests: [], posted: null,
    async fetch(url, opts = {}) {
      api.requests.push(url);
      const resource = `/api/g/${ids.id}`;
      if (!api.present || (url !== resource && url !== `${resource}/answers`)) return { status: 404, ok: false };
      if (opts.method === "POST") {
        api.posted = JSON.parse(opts.body);
        api.answered = true;
        return { status: 204, ok: true };
      }
      return { status: 200, ok: true, json: async () => ({ ...blob, answered: api.answered }) };
    },
  };
  return api;
}

async function host(api, { localStorage = storage(), reload = false, demo = false } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, textContent: "", listeners: {},
      addEventListener(event, fn) { this.listeners[event] = fn; },
    });
    return elements.get(id);
  };
  const timers = new Map();
  const copied = [];
  let mounted = null;
  const location = { pathname: demo ? "/demo" : `/g/${api.ids.id}`, hash: reload ? "" : `#${api.ids.secret}` };
  const context = {
    core, location, localStorage,
    history: { replaceState() { location.hash = ""; } },
    document: { getElementById: element, visibilityState: "visible" },
    navigator: { clipboard: { writeText: async (v) => copied.push(v) } },
    fetch: api.fetch,
    setInterval: (fn) => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    mountGrill(root, options) {
      const state = createState(options.grill, options.saved);
      mounted = { root, options, state };
      return { answers: () => state.toAnswers() };
    },
  };
  runInNewContext(source, context, { filename: "public/app.js" });
  await context.ready;
  return {
    element, copied, localStorage, timers,
    get mounted() { return mounted; },
    click: (id) => element(id).listeners.click(),
    tick: async () => { for (const fn of [...timers.values()]) await fn(); },
  };
}

test("page host: Copy answers reads the current mounted cards before sending", async () => {
  const api = await transport();
  const page = await host(api);
  page.mounted.state.own("An answer still on the cards");
  await page.click("copy-answers");
  assert.equal(page.copied[0], core.answerLines(api.grill, page.mounted.state.toAnswers()));
  assert.match(page.copied[0], /An answer still on the cards/);
});

test("page host: send and answered reload poll the actual id until deletion, preserving Copy answers", async () => {
  const api = await transport();
  const page = await host(api);
  page.mounted.state.own("Saved answer");
  const answers = page.mounted.state.toAnswers();
  await page.mounted.options.onSend(answers);
  assert.deepEqual(await core.openAnswers(api.posted, api.grill, api.ids), answers);
  assert.equal(page.element("screen-done").hidden, false);
  await page.tick();
  assert.equal(api.requests.at(-1), `/api/g/${api.ids.id}`);
  assert.equal(page.element("done-text").textContent, "Your agent has your answers.");
  assert.equal(page.timers.size, 1);
  await page.click("done-copy");
  assert.equal(page.copied[0], core.answerLines(api.grill, answers));

  const reloaded = await host(api, { localStorage: page.localStorage, reload: true });
  assert.equal(reloaded.element("screen-done").hidden, false);
  await reloaded.click("done-copy");
  assert.equal(reloaded.copied[0], core.answerLines(api.grill, answers));
  await reloaded.tick();
  assert.equal(api.requests.at(-1), `/api/g/${api.ids.id}`);
  assert.equal(reloaded.element("done-text").textContent, "Your agent has your answers.");
  api.present = false;
  await reloaded.tick();
  assert.equal(reloaded.element("done-text").textContent, "Picked up by your agent.");
  assert.equal(reloaded.timers.size, 0);
});

test("page host: a re-sent identical grill resumes hash progress before saving its new id", async () => {
  const api = await transport();
  const page = await host(api);
  page.mounted.state.own("Keep my first answer");
  const snap = page.mounted.state.snapshot();
  await page.mounted.options.onChange(snap);
  const hash = await core.contentHash(api.grill);
  const prior = JSON.parse(page.localStorage.getItem(`gm:g:${hash}`));
  const resent = await transport(api.grill);
  const resumed = await host(resent, { localStorage: page.localStorage });
  assert.deepEqual(plain(resumed.mounted.options.saved), snap);
  assert.equal(resumed.localStorage.getItem(`gm:id:${resent.ids.id}`), hash);
  assert.deepEqual(JSON.parse(resumed.localStorage.getItem(`gm:g:${hash}`)).snap, prior.snap);
  await resumed.click("copy-answers");
  assert.match(resumed.copied[0], /Keep my first answer/);
});

test("page host: a new id also recovers saved hash answers on an answered grill", async () => {
  const api = await transport();
  const page = await host(api);
  page.mounted.state.own("Keep my sent answer");
  const answers = page.mounted.state.toAnswers();
  await page.mounted.options.onSend(answers);
  const resent = await transport(api.grill);
  resent.answered = true;
  const resumed = await host(resent, { localStorage: page.localStorage });
  await resumed.click("done-copy");
  assert.equal(resumed.copied[0], core.answerLines(api.grill, answers));
});

test("page host: expired hash snapshots are not resumed for a new id", async () => {
  const api = await transport();
  const localStorage = storage();
  const hash = await core.contentHash(api.grill);
  localStorage.setItem(`gm:g:${hash}`, JSON.stringify({ ts: Date.now() - 4 * 86400000, grill: api.grill, snap: { pos: 1 } }));
  const page = await host(api, { localStorage });
  assert.equal(page.mounted.options.saved, null);
});

test("page host: demo Copy answers also reads its mounted cards without network", async () => {
  const api = await transport();
  const page = await host(api, { demo: true });
  page.mounted.state.own("Demo copy");
  await page.click("copy-answers");
  assert.match(page.copied[0], /Demo copy/);
  assert.equal(api.requests.length, 0);
});
