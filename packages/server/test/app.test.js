// Execute the real page host with a small DOM/transport shell and real crypto/storage/state.
// Most cases isolate host behavior; the send-error cases also use real mountGrill rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as core from "../../core/src/index.js";
import { createState } from "../../ui/src/state.js";
import { mountGrill as realMountGrill } from "../../ui/src/grill.js";
import { createDocument } from "../../ui/test-support/dom.js";

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

async function host(api, { localStorage = storage(), reload = false, demo = false, render = false } = {}) {
  const document = createDocument();
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const node = document.createElement("div");
      node.hidden = id.startsWith("screen-");
      elements.set(id, node);
    }
    return elements.get(id);
  };
  document.getElementById = element;
  document.visibilityState = "visible";
  element("screen-grill").append(element("grill-root"));
  const timers = new Map();
  const copied = [];
  let mounted = null;
  const location = { pathname: demo ? "/demo" : `/g/${api.ids.id}`, hash: reload ? "" : `#${api.ids.secret}` };
  const context = {
    core, location, localStorage,
    history: { replaceState() { location.hash = ""; } },
    document,
    navigator: { clipboard: { writeText: async (v) => copied.push(v) } },
    fetch: api.fetch,
    setInterval: (fn) => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    mountGrill(root, options) {
      const state = createState(options.grill, options.saved);
      mounted = { root, options, state };
      return render ? realMountGrill(root, options) : { answers: () => state.toAnswers() };
    },
  };
  runInNewContext(source, context, { filename: "public/app.js" });
  await context.ready;
  return {
    element, copied, localStorage, timers,
    get mounted() { return mounted; },
    click: (id) => element(id).click(),
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

for (const failure of ["network abort", "expired 404"]) {
  test(`real host + mountGrill: POST ${failure} shows host userMessage and preserves retry/Copy answers`, async () => {
    const api = await transport();
    const localStorage = storage();
    const hash = await core.contentHash(api.grill);
    // A real saved summary: mounting/rendering and the send handler are unmodified.
    const answers = api.grill.questions.map(() => ({ kind: "own", text: "Saved summary answer" }));
    localStorage.setItem(`gm:id:${api.ids.id}`, hash);
    localStorage.setItem(`gm:g:${hash}`, JSON.stringify({
      ts: Date.now(), grill: api.grill,
      snap: { answers, order: api.grill.questions.map((_, i) => i), pos: answers.length, skipped: [] },
    }));
    const fetch = api.fetch;
    let fail = true;
    api.fetch = async (url, options) => {
      if (options?.method === "POST" && fail) {
        if (failure === "network abort") throw new DOMException("aborted", "AbortError");
        return { status: 404, ok: false };
      }
      return fetch(url, options);
    };
    const page = await host(api, { localStorage, render: true });
    const root = page.element("grill-root");
    await assert.doesNotReject(root.querySelector(".gm-send").click());
    const note = root.querySelector(".gm-note");
    assert.ok(note?.visible);
    assert.equal(note.textContent, failure === "network abort"
      ? "Can't reach grill-me.ai. Your answers are still here — try again, or use Copy answers below."
      : "This grill expired or was picked up. Use Copy answers below and paste them into your agent's session.");
    assert.equal(root.querySelector(".gm-send").disabled, false);
    await page.click("copy-answers");
    assert.match(page.copied[0], /Saved summary answer/);
    // Recover transport; the same real handler can send again with the original answers.
    fail = false;
    await assert.doesNotReject(root.querySelector(".gm-send").click());
    assert.equal(page.element("screen-done").hidden, false);
    assert.deepEqual(await core.openAnswers(api.posted, api.grill, api.ids), {
      v: 1, answers: api.grill.questions.map((q) => ({ n: q.n, kind: "own", text: "Saved summary answer" })),
    });
  });
}
