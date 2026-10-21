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
// recreate storage. Destroy also cancels UI gesture/focus timers; replacing the actual mount
// DOM node provides a second boundary against retired nodes and asynchronous host callbacks.
//
// Delivery is only ever claimed from a POST the relay authenticated: a 204 (winner) or 200 (the
// relay already holds this exact submission, digest-checked). A poll snapshot whose submissionId
// merely matches ours is NOT proof our ciphertext won — the same id with a different blob is a
// loss — so it triggers an exact idempotent re-POST; only its 200/204 confirms delivery.
import {
  openRound, openRoundAnswers, sealRoundAnswers, deriveSessionKeys, validateRound,
} from "/core/session.js"; // direct import: never the cached 0.1 /core/index.js
import { answerLines } from "/core/answers.js"; // legacy module, byte-unchanged since 0.1
import { b64urlEncode } from "/core/crypto.js"; // legacy module, byte-unchanged since 0.1
import { LIMITS } from "/core/format.js";
import { mountGrill } from "/ui/grill.js?v=answer-fixes-1";

import { EXPIRY_HELP, RESUME_HELP, draftLines } from "/core/recovery.js?v=resume-1";

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
let awaitingNext = false; // true only after an authoritative idle/ACK snapshot
let expiresAt = null, recoveryText = null, recoveryEnded = false;
let refreshPoll = false; // reconnect must re-read state even if offline happened between polls

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
  $("screen-message").classList.remove("session-thinking");
  $("thinking-stack")?.remove();
  const home = $("screen-message").querySelector("a");
  if (home) { home.textContent = "Grill Me"; home.parentElement.hidden = false; }
  $("message-text").textContent = text;
  show("screen-message");
}
let idleHelpTimer;
const waiting = () => {
  clearTimeout(idleHelpTimer);
  const g = gen;
  idleHelpTimer = setTimeout(() => {
    if (alive && gen === g && awaitingNext) $("message-text").textContent = "Still waiting for the next questions. The agent may have stopped its turn. Return to the same chat and type Resume Grill Me. Your interview expires after one hour without a new round, answer or collection.";
  }, 45_000);
  message("Your agent is thinking. Keep this page open—your next questions will appear here.");
  const screen = $("screen-message");
  screen.classList.add("session-thinking");
  const stack = document.createElement("div");
  stack.id = "thinking-stack";
  stack.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) stack.append(document.createElement("span"));
  screen.prepend(stack);
  const home = screen.querySelector("a");
  if (home) home.parentElement.hidden = true;
};
function pauseThinking() {
  if (!$("screen-message").hidden && $("screen-message").classList.contains("session-thinking")) {
    message("Can't reach grill-me.ai right now. Try again in a moment.");
  }
}

// The relay accepted our ciphertext: readable round data is purged immediately (the encrypted
// intent stays, digest-bound, until the ack/advance), and the page waits — the poll loop mounts
// the next round automatically. Plain sent answers are deliberately not kept.
function sentScreen() {
  retireRoot();
  currentGrill = null;
  $("thinking-stack")?.remove();
  $("done-title").textContent = "Sent ✓";
  $("done-text").textContent = "Waiting for your agent to pick up your answers. If it stops waiting, type Resume Grill Me in the same chat. Copy answers is available until collection or expiry.";
  $("done-lines").hidden = true;
  $("done-copy").hidden = false; // decrypt only this current submitted intent on explicit Copy
  show("screen-done");
}

function resumePrompt() {
  return `Resume Grill Me for interview ${id}. Check for saved answers first; keep a live pending round and its draft. If expired, resend only the last unanswered questions from this chat on a fresh link.`;
}
async function copyText(text) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); $("recovery-state").textContent = "Copied."; return; } catch {}
  $("recovery-manual").textContent = text; $("recovery-manual").hidden = false;
  if (!$("recovery-dialog").open) $("recovery-dialog").showModal();
  $("recovery-manual").focus(); const selection = window.getSelection(), range = document.createRange();
  range.selectNodeContents($("recovery-manual")); selection?.removeAllRanges(); selection?.addRange(range);
  $("recovery-state").textContent = "Select and copy this text manually.";
}
async function submittedText(entry, key, round) {
  if (!entry?.roundBlob || !entry.intent?.winner || !key) return null;
  const ids = { id, secret: key, round };
  const questions = await openRound(entry.roundBlob, ids);
  return answerLines(questions, await openRoundAnswers(entry.intent, questions, ids));
}
async function copyAnswers() {
  const g = gen, round = mountedRound || readJson(curKey(id))?.round;
  let text = recoveryText;
  if (alive) {
    const answers = !$("screen-grill").hidden && grillUi ? grillUi.answers() : null;
    if (currentGrill && answers) text = draftLines(currentGrill, loadRound(round)?.snap);
    else {
      try { text = await submittedText(loadRound(round), secret, round); } catch { text = null; }
    }
    if (!alive || gen !== g || !currentRound(round)) return;
  }
  if (text) await copyText(text);
}
function recoveryInfo() {
  $("recovery-help").textContent = "Hosted phone waits: 45 seconds per call by default (up to 50). Codex plugin: 14 minutes per call. CLI background wait: no fixed total timeout. Your host can stop earlier. Inline cards do not keep an agent wait running while you answer.\n\n" + RESUME_HELP;
  $("recovery-expiry").textContent = EXPIRY_HELP + (expiresAt ? `\nCurrent server deadline: ${new Date(expiresAt).toLocaleString()}.` : "");
  $("resume-interview").hidden = true; // a normal website cannot post into an agent chat
  $("copy-resume").hidden = recoveryEnded;
  $("recovery-copy").hidden = !recoveryText && !currentGrill && !loadRound(mountedRound || readJson(curKey(id))?.round)?.intent?.winner;
  $("recovery-state").textContent = recoveryEnded ? "This interview was explicitly finished or cancelled." : "Return to the SAME agent chat and type Resume Grill Me, or copy the message below. This page cannot wake a closed agent turn.";
  $("recovery-manual").hidden = true;
}
for (const button of document.querySelectorAll("[data-recovery]")) {
  button.hidden = false; button.onclick = () => { recoveryInfo(); $("recovery-dialog").showModal(); };
}
$("recovery-close").onclick = () => $("recovery-dialog").close();
$("copy-resume").onclick = () => void copyText(resumePrompt());
$("recovery-copy").onclick = copyAnswers;
$("copy-answers").addEventListener("click", copyAnswers);
$("done-copy").addEventListener("click", copyAnswers);

// ---------- relay snapshots ----------
const END_MESSAGES = {
  finished: "All done—your agent has finished this grill.",
  cancelled: "This grill was cancelled.",
  expired: "This session expired.",
};
let endReason = null;
const knownReason = (reason) => Object.hasOwn(END_MESSAGES, reason) ? reason : null;
async function terminalReason(response) {
  try { return knownReason((await response.json()).reason); } catch { return null; }
}
function ended(reason) {
  if (!alive) return;
  // Preserve a recovery copy only in THIS open document on expiry, never storage/history.
  // Snapshot before synchronous purge; a later ACK/finish cannot recreate saved state.
  const fallbackRound = mountedRound || readJson(curKey(id))?.round;
  const entry = loadRound(fallbackRound), key = secret;
  const unsent = currentGrill && grillUi ? draftLines(currentGrill, entry?.snap)
    : entry?.grill && entry.snap ? draftLines(entry.grill, entry.snap) : null;
  const recoverable = !["finished", "cancelled"].includes(reason);
  recoveryEnded = !recoverable;
  recoveryText = recoverable ? unsent : null;
  if (recoverable && !recoveryText) void submittedText(entry, key, fallbackRound).then(text => {
    if (!alive && !recoveryEnded) { recoveryText = text; $("recovery-copy").hidden = !text; }
  }).catch(() => {});
  alive = false;
  awaitingNext = false;
  gen++; // in-flight fetch/decrypt/onChange/POST callbacks die at their next guard
  try { pollAbort?.abort(); } catch {}
  purgeAll(); // an observed finish/404/expiry clears the session key and all plaintext
  secret = null;
  writeToken = null;
  retireRoot();
  endReason = knownReason(reason);
  message((END_MESSAGES[endReason] ?? "Session ended or expired.") + (recoverable ? " Return to the same agent chat and type Resume Grill Me to resend unanswered questions on a fresh link. This old page cannot receive the new interview. Open Timeout & resume to copy any current answers recovered in this open page." : ""));
}

// No key is needed to read an end receipt. This also handles reload after purge and a second
// tab whose key was purged by the first; it never saves keys/plaintext or reopens retired cards.
async function checkEndWithoutKey() {
  const generation = gen;
  try {
    const r = await fetchBounded(`/api/s/${id}`, {}, SYNC_BOUND_MS);
    const reason = r.status === 404 ? await terminalReason(r) : null;
    if (gen !== generation || secret) return;
    if (r.status === 404) {
      if (alive) ended(reason);
      else if (!endReason && reason) {
        endReason = reason;
        if (["finished", "cancelled"].includes(reason)) {
          recoveryEnded = true; recoveryText = null; $("recovery-manual").textContent = "";
          $("recovery-copy").hidden = $("copy-resume").hidden = true;
        }
        message(END_MESSAGES[reason]);
      }
    } else if (r.status === 200 && alive) {
      message("This link is missing its key. Open the full link from your agent.");
    }
  } catch {
    if (alive && gen === generation && !secret) message("Can't reach grill-me.ai right now. Try again in a moment.");
  }
}

function mountRound(grill, round, snap, note) {
  if (!currentRound(round)) return;
  const g = ++gen; // late callbacks from the previous mount's timers become stale
  mountedRound = round;
  currentGrill = grill;
  $("thinking-stack")?.remove();
  saveRound(round, { grill });
  retireRoot();
  show("screen-grill");
  grillUi = mountGrill($("grill-root"), {
    grill,
    answerLimits: { ownChars: LIMITS.ownChars, jsonBytes: LIMITS.answersBytes - 16 }, // AES-GCM tag
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
  saveRound(round, { roundBlob: { ct: snap.ct, iv: snap.iv } });
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
  // The relay decides expiry; a device clock ahead of the relay must not invent an end reason.
  revision = snap.revision;
  expiresAt = Number.isFinite(snap.expiresAt) ? snap.expiresAt : null;
  awaitingNext = snap.state === "idle";
  safeSet(curKey(id), JSON.stringify({ ts: Date.now(), round: snap.round, revision: snap.revision, expiresAt }));

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
    if ($("screen-message").classList.contains("session-thinking")) message("Updating questions…");
    void mountRoundFromRelay(snap);
    return;
  }

  if (snap.state === "answered") {
    if (typeof snap.ct === "string" && typeof snap.iv === "string") saveRound(snap.round, { roundBlob: { ct: snap.ct, iv: snap.iv } });
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
    recoveryText = null; $("recovery-copy").hidden = true; $("recovery-manual").textContent = "";
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
  if (r.status === 404) {
    const reason = await terminalReason(r);
    if (alive && gen === g) ended(reason);
    return;
  }
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
  let r, snap, reason;
  try {
    r = await fetchBounded(`/api/s/${id}`, {}, SYNC_BOUND_MS); // an immediate snapshot
    if (r.status === 200) snap = await r.json();
    else if (r.status === 404) reason = await terminalReason(r);
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
  if (r.status === 404) return ended(reason);
  applySnapshot(snap);
}

async function pollLoop() {
  let failures = 0;
  let capacityUntil = 0; // bounded short polling when an answer collector needs our held slot
  while (alive) {
    if (!navigator.onLine) { pauseThinking(); failures = Math.max(failures, 1); await untilEvent(window, "online"); continue; }
    if (document.visibilityState !== "visible") {
      await untilEvent(document, "visibilitychange", () => document.visibilityState === "visible");
      continue;
    }
    let r, snap, reason;
    try {
      const ac = new AbortController();
      pollAbort = ac;
      const query = refreshPoll || failures ? "wait=0"
        : `after=${revision}&wait=${performance.now() < capacityUntil ? 0 : POLL_WAIT_S}`;
      refreshPoll = false;
      r = await fetchBounded(`/api/s/${id}?${query}`, { signal: ac.signal }, POLL_BOUND_MS);
      if (r.status === 429) {
        pollAbort = null;
        // The connection is healthy: keep the current draft/thinking state and read
        // updates without holding a slot. Probe long polling again after ten seconds.
        capacityUntil = performance.now() + 10_000;
        await sleep(1000 + Math.floor(Math.random() * 300));
        continue;
      }
      if (r.status === 200) snap = await r.json();
      else if (r.status === 404) reason = await terminalReason(r);
      else if (r.status !== 204 && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      pollAbort = null;
    } catch {
      pollAbort = null;
      if (!alive) return;
      pauseThinking();
      failures++;
      const delay = Math.min(30_000, 400 * 2 ** Math.min(failures - 1, 6)) + Math.floor(Math.random() * 300);
      await sleep(delay);
      continue;
    }
    if (!alive) return;
    failures = 0;
    if (r.status === 404) { ended(reason); return; }
    if (r.status === 200) {
      applySnapshot(snap);
    } else if (r.status === 204 && awaitingNext && !$("screen-message").classList.contains("session-thinking")) {
      waiting(); // a successful unchanged poll confirms the idle state after reconnect
    }
    if (alive) await sleep(performance.now() < capacityUntil ? 1000 + Math.floor(Math.random() * 300) : 150);
  }
}

// ---------- boot ----------
window.addEventListener("offline", () => { refreshPoll = true; pauseThinking(); pollAbort?.abort(); });
window.addEventListener("online", () => { if (!secret) void checkEndWithoutKey(); });
window.addEventListener("storage", (event) => {
  if (alive && event.key === secKey(id) && event.newValue === null) {
    ended(); // purge immediately; learn the authoritative reason without keeping the key
    void checkEndWithoutKey();
    return;
  }
  if (!alive || !writeToken || event.key !== curKey(id)) return;
  const seen = readJson(curKey(id));
  if (seen?.revision > revision) {
    gen++;
    awaitingNext = false;
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
    message("Checking this session…");
    void checkEndWithoutKey();
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
