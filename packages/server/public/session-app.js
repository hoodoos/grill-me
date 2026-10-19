// The persistent-interview phone host (protocol v2, 0.2.0). Loaded by /entry-020.js only for
// /g/<id>?session=2 links; legacy links keep running the unchanged /app.js.
//
// The relay holds one live state per session (pending -> answered -> idle per round). This host
// keeps exactly the current session key, the current round's grill/draft and the exact encrypted
// outgoing submission intent in localStorage — keyed by session+round, never by content hash, so
// identical questions in a later round start unanswered. No older round is retained or shown.
//
// Generation guards sit after every asynchronous boundary (fetch/decrypt and the swipe UI's
// onChange): when a transition bumps the generation, stale round-N work can neither render nor
// recreate storage. mountGrill.destroy() does not cancel the card's in-flight 200 ms swipe-commit
// timer and an old render can repopulate the same root node, so every transition retires the
// actual mount DOM node (a fresh same-id replacement): the old timer then renders a detached node.
//
// Delivery is only ever claimed from a POST the relay authenticated: a 204 (winner) or 200 (the
// relay already holds this exact submission, digest-checked). A poll snapshot whose submissionId
// merely matches ours is NOT proof our ciphertext won — the same id with a different blob is a
// loss — so it triggers an exact idempotent re-POST; only its 200/204 confirms delivery.
import {
  openRound, sealRoundAnswers, deriveSessionKeys, validateRound,
} from "/core/session.js"; // direct import: never the cached 0.1 /core/index.js
import { answerLines } from "/core/answers.js"; // legacy module, byte-unchanged since 0.1
import { b64urlEncode } from "/core/crypto.js"; // legacy module, byte-unchanged since 0.1
import { mountGrill } from "/ui/grill.js";

const $ = (id) => document.getElementById(id);
const KEEP_MS = 3 * 86400000; // abandoned local state expires after 3 days
const POLL_WAIT_S = 50; // the relay's long-poll cap
const SYNC_BOUND_MS = 25_000; // boot snapshot
const POLL_BOUND_MS = (POLL_WAIT_S + 15) * 1000; // long-poll, including a stalled body
const POST_BOUND_MS = 20_000; // answers submission

// ---------- localStorage (every call wrapped: private modes throw) ----------
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const safeDel = (k) => { try { localStorage.removeItem(k); } catch {} };
const readJson = (k) => { try { return JSON.parse(safeGet(k) || "null"); } catch { return null; } };

const secKey = (id) => `gm:s2:sec:${id}`; // { ts, secret } — survives reload, 3-day bound
const curKey = (id) => `gm:s2:cur:${id}`; // { ts, round, revision } — last seen relay state
const roundKey = (id, round) => `gm:s2:r:${id}:${round}`; // { ts, grill, snap, intent }

function dropOld() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith("gm:s2:")) continue;
      const ts = readJson(k)?.ts || 0;
      if (!ts || Date.now() - ts >= KEEP_MS) localStorage.removeItem(k);
    }
  } catch {}
}
const loadRound = (round) => readJson(roundKey(id, round));
function currentRound(round) {
  const seen = readJson(curKey(id));
  return alive && (!seen || (seen.round === round && seen.revision <= revision));
}
function saveRound(round, patch) {
  if (!currentRound(round)) return;
  safeSet(roundKey(id, round), JSON.stringify({ ...(loadRound(round) || {}), ...patch, ts: Date.now() }));
}
const purgeRound = (round) => safeDel(roundKey(id, round));
// Current-only storage: every other round's plaintext for this session goes. `except` null purges all.
function purgeRoundsExcept(except) {
  try {
    const prefix = `gm:s2:r:${id}:`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix) && k !== (except == null ? null : roundKey(id, except))) localStorage.removeItem(k);
    }
  } catch {}
}
function purgeAll() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k === secKey(id) || k === curKey(id) || k?.startsWith(`gm:s2:r:${id}:`)) localStorage.removeItem(k);
    }
  } catch {}
  mountedRound = 0;
}

// ---------- bounded fetch (a stalled relay must not freeze same-link updates) ----------
async function fetchBounded(url, options, ms) {
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (options.signal?.aborted) ac.abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const t = setTimeout(() => ac.abort(new Error("bounded fetch timeout")), ms);
  try {
    const response = await fetch(url, { ...options, signal: ac.signal });
    const body = await response.text(); // keep timeout and cancellation through body completion
    return { status: response.status, json: async () => JSON.parse(body) };
  } finally {
    clearTimeout(t);
    options.signal?.removeEventListener("abort", abort);
  }
}

// ---------- session identity ----------
const id = location.pathname.startsWith("/g/") ? location.pathname.slice(3) : "";
const params = new URLSearchParams(location.search);
let secret = null;
let writeToken = null; // proves the link holder for authenticated relay writes

// ---------- host state ----------
let alive = true;
let gen = 0; // bumped on every confirmed transition: stale async work dies at its next guard
let revision = 0; // last snapshot revision seen from the relay
let mountedRound = 0; // the round the cards currently belong to
let currentGrill = null; // memory-only, for the grill screen's Copy answers while unsent
let grillUi = null;
let pollAbort = null;

const stale = () => Object.assign(new Error("stale round"), { userMessage: "This round moved on." });

// ---------- screens ----------
function retireRoot() {
  if (grillUi) { try { grillUi.destroy(); } catch {} grillUi = null; }
  const old = $("grill-root");
  const fresh = old.cloneNode(false);
  fresh.removeAttribute("class");
  old.replaceWith(fresh); // old swipe timers and renders now target a detached node
}
const show = (screen) => {
  for (const s of ["screen-message", "screen-grill", "screen-done"]) $(s).hidden = s !== screen;
};
function message(text) {
  retireRoot();
  currentGrill = null;
  $("message-text").textContent = text;
  show("screen-message");
}
const waiting = () => message("Your agent has your answers. Waiting for the next questions…");

// The relay accepted our ciphertext: readable round data is purged immediately (the encrypted
// intent stays, digest-bound, until the ack/advance), and the page waits — the poll loop mounts
// the next round automatically. Plain sent answers are deliberately not kept.
function sentScreen() {
  retireRoot();
  currentGrill = null;
  $("done-title").textContent = "Sent ✓";
  $("done-text").textContent = "Waiting for your agent to pick up your answers.";
  $("done-lines").hidden = true;
  $("done-copy").hidden = true; // submitted plaintext is deliberately no longer retained
  show("screen-done");
}

async function copyAnswers() {
  // Copy answers is for the UNSENT state: the live cards (works offline, draft included).
  // Winning submissions purge their plaintext, so there is deliberately nothing to copy there.
  const answers = !$("screen-grill").hidden && grillUi ? grillUi.answers() : null;
  if (!currentGrill || !answers) return;
  const text = answerLines(currentGrill, answers);
  try { await navigator.clipboard.writeText(text); return; } catch {}
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

// ---------- relay snapshots ----------
function ended() {
  if (!alive) return;
  alive = false;
  gen++; // in-flight fetch/decrypt/onChange/POST callbacks die at their next guard
  try { pollAbort?.abort(); } catch {}
  purgeAll(); // an observed finish/404/expiry clears the session key and all plaintext
  secret = null;
  writeToken = null;
  retireRoot();
  message("Session ended or expired."); // generic: never an invented completion
}

function mountRound(grill, round, snap, note) {
  if (!currentRound(round)) return;
  const g = ++gen; // late callbacks from the previous mount's timers become stale
  mountedRound = round;
  currentGrill = grill;
  saveRound(round, { grill });
  retireRoot();
  show("screen-grill");
  grillUi = mountGrill($("grill-root"), {
    grill,
    saved: snap,
    note,
    onChange: (s) => {
      if (!alive || gen !== g || mountedRound !== round || !currentRound(round)) return;
      if (loadRound(round)?.intent) return; // an ambiguous submission keeps its original draft
      saveRound(round, { grill, snap: s });
    },
    onSend: (answers) => sendAnswers(answers, round, g),
  });
}

async function mountRoundFromRelay(snap) {
  const g = gen, rev = snap.revision, round = snap.round;
  let grill;
  try {
    grill = await openRound({ ct: snap.ct, iv: snap.iv }, { id, secret, round });
  } catch {
    if (alive && gen === g && revision === rev && currentRound(round)) {
      message("This link's key can't open these questions. Open the full link from your agent, or reload to try again.");
    }
    return;
  }
  if (!alive || gen !== g || revision !== rev) return; // superseded while decrypting
  const local = loadRound(round);
  mountRound(grill, round, local?.snap ?? null, "");
}

function applySnapshot(snap) {
  if (!alive) return;
  if (!snap || snap.v !== 2 || snap.id !== id || !validateRound(snap.round)) return;
  if (!Number.isInteger(snap.revision) || snap.revision < 1) return;
  if (!["pending", "answered", "idle"].includes(snap.state)) return;
  // Stale or contradictory snapshots write nothing and render nothing: late answered/idle from
  // round N cannot regress the live N+1, and no commit happens before these checks.
  if (snap.revision < revision) return;
  if (snap.round < mountedRound) return;
  const seen = readJson(curKey(id));
  if (seen?.revision > snap.revision) return; // another tab has already observed the next state
  if (snap.expiresAt && snap.expiresAt <= Date.now()) return ended();
  revision = snap.revision;
  safeSet(curKey(id), JSON.stringify({ ts: Date.now(), round: snap.round, revision: snap.revision }));

  if (snap.state === "pending" && typeof snap.ct === "string" && typeof snap.iv === "string") {
    if (snap.round === mountedRound && grillUi) return; // the live round: keep the draft
    purgeRoundsExcept(snap.round); // current-only: any other round's plaintext goes
    if (snap.round === mountedRound && !grillUi) {
      // The relay is still pending on a round we hold an intent for (a lost send reply):
      // remount the saved draft; retrying reuses the exact encrypted intent.
      const local = loadRound(snap.round);
      if (local?.grill) {
        mountRound(local.grill, snap.round, local.snap ?? null, "Not sent yet — try Send again, or use Copy answers below.");
        return;
      }
    }
    void mountRoundFromRelay(snap);
    return;
  }

  if (snap.state === "answered") {
    const intent = loadRound(snap.round)?.intent;
    if (intent && snap.submissionId === intent.submissionId && intent.winner) {
      sentScreen(); // reload after a confirmed win: the truthful sent/wait screen, nothing else
      return;
    }
    if (intent && snap.submissionId === intent.submissionId) {
      // Not proof of delivery: the winning blob could differ under our submissionId. Re-send the
      // exact saved intent; only the relay's digest-checked 200/204 confirms it won.
      void retryIntent(snap.round);
      return;
    }
    // A different submission won. Never claim our answers were sent; keep the unsent current
    // draft until the relay proves ack/advance (purged in the idle/pending branches).
    if (grillUi && mountedRound === snap.round) {
      grillUi.setNote("Another device answered this round. These answers were not sent.");
    } else if (!grillUi) {
      const local = loadRound(snap.round);
      if (local?.grill) {
        purgeRoundsExcept(snap.round);
        mountRound(local.grill, snap.round, local.snap ?? null, "Another device answered this round. These answers were not sent; Copy answers is still available until the round advances.");
      } else {
        message("Another device answered this round. Waiting for the next questions…");
      }
    }
    return;
  }

  if (snap.state === "idle") {
    // The agent acked: every round's data goes (the session key stays until finish/expiry).
    // Bumping the generation also kills a late POST reply from the round just acked.
    purgeRoundsExcept(null);
    mountedRound = 0;
    currentGrill = null;
    gen++;
    waiting();
    return;
  }
}

// ---------- sending answers ----------
function intentBody(intent) {
  return {
    expectedRevision: intent.expectedRevision,
    submissionId: intent.submissionId,
    ct: intent.ct,
    iv: intent.iv,
  };
}

function postIntent(round, intent) {
  return fetchBounded(`/api/s/${id}/rounds/${round}/answers`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` },
    body: JSON.stringify(intentBody(intent)),
  }, POST_BOUND_MS);
}

async function sendAnswers(answers, round, g) {
  if (!alive || gen !== g || mountedRound !== round || !currentGrill) throw stale();
  const entry = loadRound(round);
  let intent = entry?.intent;
  const answerDigest = b64urlEncode(new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(JSON.stringify(answers)),
  )));
  if (!alive || gen !== g || mountedRound !== round || !currentRound(round)) throw stale();
  if (intent && intent.answerDigest !== answerDigest) {
    throw Object.assign(new Error("unconfirmed submission"), {
      userMessage: "The earlier submission is unconfirmed. Reload to recover/check its saved answers before changing them; retrying must send the same answers.",
    });
  }
  if (!intent) {
    // The exact encrypted outgoing intent: sealed once, persisted before the request, and
    // reused verbatim on every retry — a lost reply never mints a second ciphertext.
    const blob = await sealRoundAnswers(answers, currentGrill, { id, secret, round });
    if (!alive || gen !== g || mountedRound !== round) throw stale();
    intent = { submissionId: newOpId(), ct: blob.ct, iv: blob.iv, expectedRevision: revision, answerDigest, winner: false };
    saveRound(round, { intent });
    const saved = loadRound(round)?.intent;
    if (!saved || saved.submissionId !== intent.submissionId || saved.ct !== intent.ct || saved.iv !== intent.iv) {
      // Storage refused the exact intent: do NOT send. A lost reply would leave no recoverable
      // record, and a retry could not prove (or repeat) what went out.
      purgeRound(round);
      throw Object.assign(new Error("storage"), {
        userMessage: "Can't keep your answers on this device. Use Copy answers below and paste them into your agent's session.",
      });
    }
  }
  let r;
  try {
    r = await postIntent(round, intent);
  } catch {
    if (!alive || gen !== g) throw stale();
    // Lost reply (or a stalled relay): the saved intent makes the retry exact.
    throw Object.assign(new Error("network"), {
      userMessage: "Can't reach grill-me.ai. The earlier submission may have arrived. Retry sends the same saved answers; reload to check/recover them, or use Copy answers.",
    });
  }
  if (!alive || gen !== g) throw stale();
  if (!currentRound(round)) throw stale();
  await settleIntent(round, intent, r, g);
}

// Exact idempotent retry after a lost reply or a matching-id poll snapshot: only a digest-checked
// 200/204 proves our ciphertext won. A 409 here means a different blob won under this id (or the
// round moved on) — loser guidance, never a delivered claim.
async function retryIntent(round) {
  const g = gen;
  const intent = loadRound(round)?.intent;
  if (!intent || intent.winner || !alive) return;
  let r;
  try {
    r = await postIntent(round, intent);
  } catch {
    return; // still unreachable; the next observed snapshot retries, or the user presses Send
  }
  if (!alive || gen !== g) return;
  if (!currentRound(round)) return;
  await settleIntent(round, intent, r, g);
}

async function settleIntent(round, intent, r, g) {
  if (r.status === 204 || r.status === 200) {
    // The relay holds this exact submission: readable grill/draft/answers are purged now and
    // the page waits for the ack and the next round.
    saveRound(round, { grill: null, snap: null, intent: { ...intent, winner: true } });
    sentScreen();
    gen++;
    return;
  }
  if (r.status === 404) { ended(); return; }
  if (r.status === 409) {
    if (!alive || gen !== g) return;
    // A different submission won this round. Never claim ours were delivered; the draft stays
    // (Copy answers works) until the relay proves ack/advance, then it is purged.
    grillUi?.setNote("Another device answered this round. These answers were not sent.");
    return;
  }
  throw new Error(`HTTP ${r.status}`);
}

// Random canonical 16-char operation id (the relay scopes it to the current round).
function newOpId() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return b64urlEncode(b);
}

// ---------- polling (bounded wait, error backoff, visibility/online aware, no history) ----------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const untilEvent = (target, event, ok = () => true) =>
  new Promise((res) => {
    const h = () => { if (ok()) { target.removeEventListener(event, h); res(); } };
    target.addEventListener(event, h);
  });

async function syncOnce() {
  const generation = gen;
  let r, snap;
  try {
    r = await fetchBounded(`/api/s/${id}`, {}, SYNC_BOUND_MS); // an immediate snapshot
    if (r.status === 200) snap = await r.json();
    else if (r.status !== 404) throw new Error(`HTTP ${r.status}`);
  } catch {
    if (!alive || gen !== generation) return;
    // Offline: the current unconfirmed draft stays usable, including Copy answers. An offline
    // browser cannot be remotely erased, and this page never claims otherwise.
    const cur = readJson(curKey(id));
    const local = cur && validateRound(cur.round) ? loadRound(cur.round) : null;
    if (local?.grill && Number.isInteger(cur.revision) && cur.revision >= 1 && cur.revision <= 2147483647) {
      revision = cur.revision; // an offline reload must seal/retry against the saved live revision
      purgeRoundsExcept(cur.round); // offline reload keeps only the current round
      mountRound(local.grill, cur.round, local.snap ?? null, "Can't reach grill-me.ai right now — your saved answers are still here.");
    } else {
      message("Can't reach grill-me.ai right now. Try again in a moment.");
    }
    return; // the poll loop keeps retrying in the background
  }
  if (!alive || gen !== generation) return;
  if (r.status === 404) return ended();
  applySnapshot(snap);
}

async function pollLoop() {
  let failures = 0;
  while (alive) {
    if (!navigator.onLine) { await untilEvent(window, "online"); continue; }
    if (document.visibilityState !== "visible") {
      await untilEvent(document, "visibilitychange", () => document.visibilityState === "visible");
      continue;
    }
    let r, snap;
    try {
      const ac = new AbortController();
      pollAbort = ac;
      r = await fetchBounded(`/api/s/${id}?after=${revision}&wait=${POLL_WAIT_S}`, { signal: ac.signal }, POLL_BOUND_MS);
      if (r.status === 200) snap = await r.json();
      else if (r.status !== 204 && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      pollAbort = null;
    } catch {
      pollAbort = null;
      if (!alive) return;
      failures++;
      const delay = Math.min(30_000, 400 * 2 ** Math.min(failures - 1, 6)) + Math.floor(Math.random() * 300);
      await sleep(delay);
      continue;
    }
    if (!alive) return;
    failures = 0;
    if (r.status === 404) { ended(); return; }
    if (r.status === 200) {
      applySnapshot(snap);
    }
    if (alive) await sleep(150);
  }
}

// ---------- boot ----------
window.addEventListener("storage", (event) => {
  if (alive && event.key === secKey(id) && event.newValue === null) return ended();
  if (!alive || !writeToken || event.key !== curKey(id)) return;
  const seen = readJson(curKey(id));
  if (seen?.revision > revision) {
    gen++;
    mountedRound = 0;
    message("Updating questions…");
    void syncOnce();
  }
});
dropOld();
if (params.get("session") !== "2" || !/^[A-Za-z0-9_-]{16}$/.test(id)) {
  message("This link doesn't name a session. Open the full link from your agent.");
} else {
  // The key arrives in the #fragment: save it, then strip the fragment while keeping the
  // ?session=2 marker in the address (a reload still works; the key mostly stays out of
  // synced history).
  const fromHash = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{22}$/.test(fromHash)) {
    secret = fromHash;
    safeSet(secKey(id), JSON.stringify({ ts: Date.now(), secret }));
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    const saved = readJson(secKey(id));
    if (saved?.secret && /^[A-Za-z0-9_-]{22}$/.test(saved.secret)) secret = saved.secret;
  }
  if (!secret) {
    message("This link is missing its key. Open the full link from your agent.");
  } else {
    const keySecret = secret;
    try {
      const keys = await deriveSessionKeys(keySecret);
      if (alive && secret === keySecret) writeToken = keys.writeToken;
    } catch {
      if (alive && secret === keySecret) {
        message("This link's key doesn't work. Open the full link from your agent.");
        secret = null;
      }
    }
    if (secret && alive && writeToken) {
      void syncOnce();
      void pollLoop();
    }
  }
}
