// The grill page host: keys, storage, network and screens. All crypto and format work goes
// through /core; the swipe UI is /ui/grill.js and is handed only plain objects.
//
// Screens live in grill.html: #screen-message (plain message), #screen-grill (the cards),
// #screen-done (after sending).
import {
  openGrill, sealAnswers, deriveKeys, contentHash, answerLines,
  convert, DEMO_TEXT, isId, isSecret, LIMITS,
} from "/core/index.js";
import { mountGrill } from "/ui/grill.js?v=answer-fixes-1";

const $ = (id) => document.getElementById(id);
const KEEP_MS = 3 * 86400000; // local copies expire after 3 days
const DEMO = location.pathname === "/demo";

// ---------- localStorage (every call wrapped: private modes throw) ----------
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const safeDel = (k) => { try { localStorage.removeItem(k); } catch {} };

const secKey = (id) => `gm:sec:${id}`;
const grillKey = (hash) => `gm:g:${hash}`;
const idKey = (id) => `gm:id:${id}`;

function dropOld() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith("gm:g:")) continue;
      const ts = JSON.parse(localStorage.getItem(k) || "{}")?.ts || 0;
      if (Date.now() - ts >= KEEP_MS) localStorage.removeItem(k);
    }
  } catch {}
}
function saveLocal(id, hash, grill, snap, answers) {
  safeSet(grillKey(hash), JSON.stringify({ ts: Date.now(), grill, snap: snap ?? null, answers: answers ?? null }));
  safeSet(idKey(id), hash);
}
function loadByHash(hash) {
  try {
    const v = hash && JSON.parse(safeGet(grillKey(hash)) || "null");
    return v && Date.now() - v.ts < KEEP_MS ? v : null;
  } catch { return null; }
}
const loadLocal = (id) => loadByHash(safeGet(idKey(id)));

// ---------- screens ----------
const show = (id) => {
  for (const s of ["screen-message", "screen-grill", "screen-done"]) $(s).hidden = s !== id;
};
const message = (text) => { $("message-text").textContent = text; show("screen-message"); };

let currentGrill = null;
let currentAnswers = null;
let grillUi = null; // the mounted cards UI, while the grill screen is up

async function copyAnswers() {
  // On the grill screen, copy what's currently answered (works offline/expired); on the done
  // screen, copy what was sent.
  const answers = !$("screen-grill").hidden && grillUi ? grillUi.answers() : currentAnswers;
  const text = answerLines(currentGrill, answers);
  try { await navigator.clipboard.writeText(text); return; } catch {}
  // Fallback: select a read-only textarea.
  const ta = document.createElement("textarea");
  ta.readOnly = true;
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  try { document.execCommand("copy"); } catch {}
  ta.remove();
}
$("copy-answers").addEventListener("click", copyAnswers);
$("done-copy").addEventListener("click", copyAnswers);

// After sending: poll until the agent has picked the grill up (it DELETEs it), 5 s for 15 min,
// only while the page is visible.
function doneScreen({ id = null, demo = false }) {
  grillUi = null;
  show("screen-done");
  if (demo) {
    $("done-title").textContent = "Demo: nothing was sent";
    $("done-text").textContent = "This is what your agent would receive:";
    $("done-lines").hidden = false;
    $("done-lines").textContent = answerLines(currentGrill, currentAnswers);
    return;
  }
  $("done-title").textContent = "Sent ✓";
  $("done-text").textContent = "Your agent has your answers.";
  const t0 = Date.now();
  const poll = setInterval(async () => {
    if (Date.now() - t0 > 15 * 60 * 1000) return clearInterval(poll);
    if (document.visibilityState !== "visible") return;
    try {
      const r = await fetch(`/api/g/${id}`);
      if (r.status === 404) { $("done-text").textContent = "Picked up by your agent."; clearInterval(poll); }
    } catch {} // a brief network error is retried at the next tick
  }, 5000);
}

// ---------- /demo: the same page on the built-in sample, with no network at all ----------
function runDemo() {
  const { ok, grill } = convert(DEMO_TEXT);
  if (!ok) return message("The demo grill failed to load.");
  currentGrill = grill;
  show("screen-grill");
  grillUi = mountGrill($("grill-root"), {
    grill,
    onSend: (answers) => { currentAnswers = answers; doneScreen({ demo: true }); return Promise.resolve(); },
  });
}

// ---------- /g/:id ----------
async function runGrill(id) {
  // The key arrives in the #fragment: save it and remove it from the address (a reload still
  // works, and the key mostly stays out of synced history).
  const fromHash = location.hash.slice(1);
  if (isSecret(fromHash)) {
    safeSet(secKey(id), fromHash);
    history.replaceState(null, "", location.pathname);
  }
  const secret = fromHash && isSecret(fromHash) ? fromHash : safeGet(secKey(id));
  if (!secret || !isSecret(secret))
    return message("This link is missing its key. Open the full link or QR code from your agent.");
  const ids = { id, secret };
  const { writeToken } = await deriveKeys(secret);
  let local = loadLocal(id);

  let grill = null;
  let answered = false;
  try {
    const r = await fetch(`/api/g/${id}`);
    if (r.status === 404) {
      if (!local) return message("This grill expired or was picked up by your agent.");
      grill = local.grill;
      mount(grill, local.snap, "This grill expired or was picked up — finish swiping and use Copy answers below.");
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    grill = await openGrill({ ct: data.ct, iv: data.iv }, ids);
    answered = data.answered;
    const hash = await contentHash(grill);
    // A re-sent grill has a new id but the same content. Recover its shared progress before
    // saving the new id mapping, otherwise a first visit overwrites the earlier snapshot.
    local = loadByHash(hash);
    saveLocal(id, hash, grill, local?.snap ?? null, local?.answers ?? null);
  } catch {
    // Network failure (or undecryptable data): the local copy still lets you finish.
    if (!local) return message("Can't reach grill-me.ai right now. Try again in a moment.");
    grill = local.grill;
    mount(grill, local.snap, "Can't reach grill-me.ai right now — finish swiping and use Copy answers below.");
    return;
  }

  currentGrill = grill;
  if (answered) {
    // Answers were already sent from this or another device.
    currentAnswers = local?.answers ?? { v: 1, answers: [] };
    return doneScreen({ id });
  }
  mount(grill, local?.snap ?? null, "");

  async function onSend(answers) {
    const blob = await sealAnswers(answers, grill, ids);
    let r;
    try {
      r = await fetch(`/api/g/${id}/answers`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` },
        body: JSON.stringify(blob),
      });
    } catch {
      throw Object.assign(new Error("network"), { userMessage: "Can't reach grill-me.ai. Your answers are still here — try again, or use Copy answers below." });
    }
    if (r.status === 404)
      throw Object.assign(new Error("gone"), { userMessage: "This grill expired or was picked up. Use Copy answers below and paste them into your agent's session." });
    if (r.status === 409) { finish(answers); return; } // already answered: that's fine
    if (r.status !== 204) throw new Error(`HTTP ${r.status}`);
    finish(answers);
  }

  function finish(answers) {
    currentAnswers = answers;
    // The send succeeded, so the saved progress can go; the grill and the answers stay for
    // the done screen's Copy answers.
    try {
      const hash = safeGet(idKey(id));
      const v = hash && JSON.parse(safeGet(grillKey(hash)) || "null");
      if (v) { v.snap = null; v.answers = answers; safeSet(grillKey(hash), JSON.stringify(v)); }
    } catch {}
    doneScreen({ id });
  }

  function mount(g, snap, note) {
    currentGrill = g;
    show("screen-grill");
    grillUi = mountGrill($("grill-root"), {
      grill: g,
      answerLimits: { ownChars: LIMITS.ownChars, jsonBytes: LIMITS.answersBytes - 16 }, // AES-GCM tag
      saved: snap,
      note,
      onChange: async (s) => {
        try {
          const hash = await contentHash(g);
          const prev = JSON.parse(safeGet(grillKey(hash)) || "null");
          saveLocal(id, hash, g, s, prev?.answers ?? null);
        } catch {}
      },
      onSend,
    });
  }
}

dropOld();
if (DEMO) runDemo();
else {
  const id = location.pathname.startsWith("/g/") ? location.pathname.slice(3) : "";
  if (!isId(id)) message("This link doesn't name a grill. Open the full link or QR code from your agent.");
  else runGrill(id);
}
