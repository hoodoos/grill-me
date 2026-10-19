// Stateless app transport. Capabilities/keys/plaintext exist in a call only. Never log input,
// results or exceptions; persistent storage belongs exclusively to the encrypted relay.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { convert, validateGrill, answerLines, newSecret, isId } from "../../core/src/index.js";
import { parseSessionLink, makeSessionLink, sealRound, openRound, openRoundAnswers, deriveSessionKeys, validateRound } from "../../core/src/session.js";
import { GRILL_SCHEMA } from "../../core/src/format.js";
import { MODERN, modernRequest, modernResult } from "./mcp-modern.js";
import { EVENT_NAME } from "./answer-events.js";
import { appResource } from "./mcp-app-resource.js";

const ORIGIN = "https://grill-me.ai";
const ORIGINS = new Set([ORIGIN, "https://claude.ai", "https://chatgpt.com"]);
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const PREPARE_MS = 600_000;
const UPSTREAM = readFileSync(new URL("../../core/src/grilling.md", import.meta.url), "utf8");
const INLINE_GUIDANCE = "After the FIRST READY, call grill_show ONCE with this saved link. Supporting MCP Apps hosts render the swipe cards; others keep the SAME phone-link fallback. Keep the SAME view across every later round; never refresh it with another grill_show. In-chat committed Send requests a UI follow-up: read/retain/ACK and publish the next frontier. Use UI follow-up for an actually rendered inline view, phone events for the phone path; do not subscribe to native events merely to duplicate inline follow-ups. ";
export const HOSTED_INSTRUCTIONS =
  "Grill Me interviews: call grill_start once, retain its private link; grill_send publishes each explicit round on that same link. Show every question in full, then 'Grill it on your phone' and the link. grill_wait returns answers without clearing them. Only AFTER receiving and retaining the answer lines, call grill_ack with the exact receipt; then publish the next round or grill_finish. WAITING: repeat wait. Retry uncertain writes with the same arguments. Never ACK before receiving answers. " +
  "An explicit grilling request uses these tools even for one clarification; otherwise a lone unsolicited question can stay in chat. Follow the complete unchanged Matt Pocock workflow below. Never attach unrelated interviews to a previous link. Keep the link private; it contains the encryption capability. " +
  "App mode handles plaintext and keys transiently on Grill Me's server; only ciphertext is persisted. The model/provider also sees the questions, answers and private link. Do not print QR codes. Finish only after shared-understanding confirmation; cancel when abandoning the interview. No answer history is kept here.\n\n" + INLINE_GUIDANCE + "\n\n" + UPSTREAM;
const CONTINUATION = "Keep the user on the SAME phone page for the whole interview, including final shared-understanding confirmation as a phone round. Make the phone link visible BEFORE blocking waits. With native MCP Events, subscribe to grill.answers_ready for this private link so the SAME subscribed host chat wakes automatically, then wait/read/retain/ACK and publish the next frontier. A webhook2xx is NOT answer delivery or ACK. Without wake support, immediately call grill_wait and repeat WAITING while the host keeps its turn active; this cannot wake an ended turn. Never ask the user to type answered/done or ask permission merely to continue. Grok automations are fresh runs, NOT the previous chat: save/read/update the design tree and answers in a host-owned durable checkpoint before ACK; missing toolable persistent context means automatic continuation is unavailable and answers MUST NOT be ACKed. ";

const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const field = (description, type = "string") => ({ type, description });
const linkField = field("The exact private https://grill-me.ai/g/...?...#... link returned by grill_start. Never substitute another host.");
const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CONTEXT_RECEIPT = { type: "object", additionalProperties: false, properties: {
  reference: field("Exact durable host-owned context reference registered with Grok automation; never the design-tree contents."),
  revision: field("Updated host checkpoint version after retaining this round's answers and design tree; unique for each new ACK."),
}, required: ["reference", "revision"] };
// The shared format supports transport-only callers without advice. Hosted interviews follow
// Matt's workflow: every frontier question must offer a recommendation that "yes" accepts.
const HOSTED_GRILL_SCHEMA = structuredClone(GRILL_SCHEMA);
HOSTED_GRILL_SCHEMA.properties.questions.items.required = ["title", "recommend"];
HOSTED_GRILL_SCHEMA.properties.questions.items.properties.recommend.description = "Required recommended answer: include why and/or the advised choice. Word the question so yes accepts it.";
const def = (name, description, properties, required, extra = {}) => ({ name, title: name.replaceAll("_", " "), description,
  inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { ...annotations, ...extra }, _meta: { ui: { visibility: ["model"] } } });
const TOOLS = [
  def("grill_start", "Start EVERY new Grill Me interview here, BEFORE drafting questions. The result includes the complete Matt Pocock grilling skill; read and follow it, not just the transport instructions. Map a design tree, ask only the whole settled-prerequisite frontier, number questions and give each a recommended answer so yes accepts it. Look up facts yourself; ask the user for decisions. Recompute after answers; stop only after an empty frontier and confirmed shared understanding. This allocates a private link only; retain it for every round. Lost start reply publishes nothing.", {}, [], { readOnlyHint: true, idempotentHint: false }),
  def("grill_send", "Publish ONLY the current whole frontier after reading the full skill returned by grill_start. Prefer text in Matt's exact format: ❓ **Q1** - **Title**: body, then ➡️ recommended answer; separate numbered questions with ---. Every question needs a recommendation and yes must accept it. Keep dependent questions for later rounds. Structured grill is allowed with equivalent recommendations. Use saved link, explicit round and idle expectedRevision (0 first). Pass exactly one of grill or text. Show ALL questions in that format in chat, then Grill it on your phone plus link. Retry uncertain writes with EXACT saved arguments; never replace pending/uncollected content.", {
    link: linkField, round: field("Explicit round:1 first, then current+1.", "integer"), expectedRevision: field("0 on first publish, then exact idle revision from ACK.", "integer"),
    grill: HOSTED_GRILL_SCHEMA, text: field("Preferred: complete current frontier in Matt's original numbered ❓ question / ➡️ recommended-answer format, with --- between questions."), title: field("Optional interview name."),
  }, ["link", "round", "expectedRevision"]),
  def("grill_wait", "Wait for this exact round's answers (default45 seconds, max50). WAITING: call again with same link/round. ANSWERS: retain/read the actual answer lines THEN call grill_ack with the exact returned receipt. Merely returning answers never clears them. IDLE means already acknowledged; publish next round or finish.", {
    link: linkField, round: field("The explicit published round.", "integer"), seconds: field("Wall-clock wait budget, default45/max50 seconds.", "integer"),
  }, ["link", "round"], { readOnlyHint: true }),
  def("grill_ack", "Confirm you actually RECEIVED AND RETAINED the answers from grill_wait. Pass its exact receipt unchanged, including original expectedRevision. This clears only that round's ciphertexts. Retry identical ACK after lost reply; a late old ACK cannot erase the next round. Never call this before receiving answer lines.", {
    link: linkField, receipt: { type: "object", additionalProperties: false, properties: {
      round: field("Exact received round.", "integer"), expectedRevision: field("Exact ANSWERS revision, not a later snapshot.", "integer"), submissionId: field("Exact answer submission identifier."),
    }, required: ["round", "expectedRevision", "submissionId"] },
    contextReceipt: CONTEXT_RECEIPT,
  }, ["link", "receipt"], { destructiveHint: true }),
  def("grill_finish", "Explicitly finish this interview only AFTER confirming shared understanding. Requires an idle session at its exact current revision; pending questions/uncollected answers are refused. A known finished receipt makes retry safe.", {
    link: linkField, expectedRevision: field("Exact current idle revision.", "integer"),
  }, ["link", "expectedRevision"], { destructiveHint: true }),
  def("grill_cancel", "Abort this interview when the user answered in chat or abandoned it. May discard pending questions/uncollected answers. Do not use to collect answers.", { link: linkField }, ["link"], { destructiveHint: true }),
  def("grill_subscribe", "Grok automation adapter ONLY, not old-chat resume. Before registration save this private link, full Matt workflow and design tree in durable host-owned automation context that each fresh run can read AND update. Supply account-provided webhook and secret. No verification POST/paid test run is made. Receiver configuration does NOT prove context continuity; if host context tools are unavailable do NOT register or ACK. Each ACK requires contextReceipt for an updated checkpoint. ChatGPT uses native events/subscribe instead.", {
    link: linkField, url: field("Grok account-provided public HTTPS443 automation webhook; kept encrypted at rest."), secret: field("Account-provided whsec_ Standard Webhooks secret; never display/log."),
    contextReference: field("Reference to the established durable host checkpoint containing the link, workflow and design tree; no contents."), ttlMs: field("Requested finite lifetime, capped1hour.", "integer"),
  }, ["link", "url", "secret", "contextReference"], { openWorldHint: true }),
  def("grill_unsubscribe", "Stop this interview's configured Grok webhook without collecting or clearing answers. Idempotent. Keep the private link for wait/collection or cancel separately.", {
    link: linkField, url: field("The exact previously configured callback URL."),
  }, ["link", "url"]),
];
const resource = appResource();
const showTool = def("grill_show", "Display the current interview as interactive swipe cards inside a host that supports MCP Apps. Call AFTER publishing, with the saved private link. This separate render tool does not publish or collect. Keep this view for subsequent rounds; do not call again to refresh it. Unsupported hosts use the SAME phone link from grill_send. In-chat Send requests a host follow-up; read/retain with grill_wait, ACK explicitly and publish next frontier. Use UI follow-up for in-chat, native events for phone; duplicate wakeups never authorize duplicate rounds.", { link: linkField }, ["link"], { readOnlyHint: true });
showTool._meta.ui.resourceUri = resource.uri;
TOOLS.push(showTool);
for (const tool of [
  def("grill_ui_state", "App-only encrypted current-round snapshot/long wait. Never collects or acknowledges answers.", { link: linkField, afterRevision: field("Last observed revision", "integer"), seconds: field("Wait budget, max25", "integer") }, ["link"], { readOnlyHint: true }),
  def("grill_ui_submit", "App-only exact encrypted submission. Retry the SAME submission ID, revision and ciphertext after uncertain delivery. No ACK.", { link: linkField, round: field("Current round", "integer"), expectedRevision: field("Pending revision", "integer"), submissionId: field("Saved unique submission ID"), ct: field("Encrypted answers"), iv: field("AES-GCM nonce") }, ["link", "round", "expectedRevision", "submissionId", "ct", "iv"]),
]) { tool._meta.ui.visibility = ["app"]; TOOLS.push(tool); }
const safeMessages = {
  INPUT: "Invalid tool arguments. Use the advertised schema; retain the same private link and explicit round.",
  WORKFLOW: "Every frontier question needs a recommended answer so yes accepts it. Follow the full skill returned by grill_start; prefer its original numbered question and ➡️ recommendation text format. Retry with the same link and round.",
  CAPABILITY: "Invalid capability. Use the exact private Grill Me session link; other hosts are not accepted.",
  CONFLICT: "Conflicting or stale operation. Do not replace current questions or uncollected answers. Retry only the exact saved request or inspect the intended round.",
  LIMIT: "Hosted capacity limit reached. Retry later with the same saved arguments; do not create a new interview.",
  UNAVAILABLE: "Operation unconfirmed or temporarily unavailable. Retry the exact saved arguments. Answers are not cleared without explicit ACK.",
  CONTEXT: "Before ACK, retain the answers and updated design tree in the registered durable HOST checkpoint, then pass its exact reference and new revision in contextReceipt. If the host cannot read/update durable context, do not ACK; Grok fresh-run continuation is unavailable.",
};
const response = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const out = (status, extra = {}) => ({ status, ...extra });
function capability(link) {
  try {
    if (typeof link !== "string" || link.length > 256) fail("CAPABILITY");
    const u = new URL(link), ids = parseSessionLink(link);
    if (u.origin !== ORIGIN || u.username || u.password || u.search !== "?session=2" ||
      link !== makeSessionLink(ids.id, ids.secret, ORIGIN)) fail("CAPABILITY");
    return ids;
  } catch { fail("CAPABILITY"); }
}
function validateArgs(tool, a) {
  const schema = tool.inputSchema;
  if (!object(a) || Object.keys(a).some(k => !Object.hasOwn(schema.properties, k)) || schema.required.some(k => !Object.hasOwn(a, k))) fail("INPUT");
  if (a.round !== undefined && !validateRound(a.round)) fail("INPUT");
  if (a.expectedRevision !== undefined && (!Number.isInteger(a.expectedRevision) || a.expectedRevision < 0 || a.expectedRevision > 2147483647)) fail("INPUT");
  if (a.seconds !== undefined && (!Number.isInteger(a.seconds) || a.seconds < 1 || a.seconds > 50)) fail("INPUT");
  if (tool.name === "grill_ui_state" && (a.seconds > 25 || a.afterRevision !== undefined && (!Number.isInteger(a.afterRevision) || a.afterRevision < 0 || a.afterRevision > 2147483647))) fail("INPUT");
  if (tool.name === "grill_ui_submit" && (!isId(a.submissionId) || typeof a.ct !== "string" || a.ct.length > 11000 || typeof a.iv !== "string" || a.iv.length > 32)) fail("INPUT");
  if (tool.name === "grill_send" && (a.round === 1 ? a.expectedRevision !== 0 : a.expectedRevision < 1)) fail("INPUT");
  if (tool.name === "grill_finish" && a.expectedRevision < 1) fail("INPUT");
  if (a.receipt !== undefined && (!object(a.receipt) || Object.keys(a.receipt).sort().join() !== "expectedRevision,round,submissionId" ||
    !validateRound(a.receipt.round) || !Number.isInteger(a.receipt.expectedRevision) || a.receipt.expectedRevision < 1 || a.receipt.expectedRevision > 2147483647 || !isId(a.receipt.submissionId))) fail("INPUT");
}

// Drain oversized bodies rather than destroying the request before its413 can be read.
// Also bound a slow upload independently of the later tool/wait budget.
function readMessage(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0, over = false, done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("error", errorEvent); req.off("aborted", aborted);
      if (error) { chunks.length = 0; req.resume(); reject(Object.assign(new Error("body rejected"), { status: error })); }
      else resolve(value);
    };
    const data = c => { bytes += c.length; if (bytes > 32768) { over = true; chunks.length = 0; } else if (!over) chunks.push(c); };
    const end = () => {
      if (over) return finish(413);
      try { finish(null, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { finish(400); }
    };
    const errorEvent = () => finish(400), aborted = () => finish(400);
    const timer = setTimeout(() => finish(408), 15_000); timer.unref();
    req.on("data", data); req.once("end", end); req.once("error", errorEvent); req.once("aborted", aborted);
  });
}

export function createHostedMcp({ relay, events, stat, now = Date.now, version, limits = {} }) {
  const maxCreates = limits.creates ?? 600, maxWaits = limits.waits ?? 200, maxConversation = limits.conversation ?? 30;
  const creates = new Map(), conversations = new Map(), controllers = new Set();
  let waits = 0;
  let resourceReads = 0, resourceWindow = 0, resourceRequests = 0;
  const prune = () => {
    const cutoff = now() - 3_600_000;
    for (const [id, item] of creates) if (item.at <= cutoff) creates.delete(id);
    for (const [id, items] of conversations) {
      const live = items.filter(at => at > cutoff);
      live.length ? conversations.set(id, live) : conversations.delete(id);
    }
  };
  const reserve = (id, conversation) => {
    prune(); if (creates.has(id)) return;
    if (creates.size >= maxCreates) { stat("hosted_rejected", "creates"); fail("LIMIT"); }
    const list = conversation ? conversations.get(conversation) ?? [] : [];
    if (conversation && (list.length >= maxConversation || (!conversations.has(conversation) && conversations.size >= 600))) {
      stat("hosted_rejected", "conversation"); fail("LIMIT");
    }
    creates.set(id, { at: now() });
    if (conversation) conversations.set(conversation, [...list, now()]);
  };
  const ended = r => out("ENDED", { reason: ["finished", "cancelled", "expired"].includes(r.body?.reason) ? r.body.reason : "unknown" });
  const check = r => { if (r.status === 429) fail("LIMIT"); if (r.status === 403 || r.status === 401) fail("CAPABILITY"); if (r.status === 409) fail("CONFLICT"); if (r.status >= 400) fail("UNAVAILABLE"); return r; };
  async function call(name, args, ctx) {
    if (name === "grill_start") {
      // A stateless initial-publication lease fits the existing16-char id. It prevents a
      // very late round1 retry resurrecting an ended session after its reason receipt was
      // pruned, without adding tombstones/history or persisting any preparation secret.
      const bytes = crypto.randomBytes(12), issued = Math.floor(now() / 1000);
      bytes.writeUInt32BE(issued, 0);
      return out("PREPARED", { link: makeSessionLink(bytes.toString("base64url"), newSecret(), ORIGIN), round: 1, expectedRevision: 0,
        publishBefore: issued * 1000 + PREPARE_MS, grillingInstructions: CONTINUATION + HOSTED_INSTRUCTIONS,
        message: "Capability allocated only; no questions published. Retain this link and publish round1/revision0 within10minutes. Published sessions retain their normal refreshed1hour expiry." });
    }
    const ids = capability(args.link), keys = await deriveSessionKeys(ids.secret);
    if (name === "grill_subscribe" || name === "grill_unsubscribe") {
      const scope = { sessionId: ids.id, authHash: keys.writeHash, preparedUntil: Buffer.from(ids.id, "base64url").readUInt32BE(0) * 1000 + PREPARE_MS };
      if (name === "grill_unsubscribe") { events.unsubscribe({ ...scope, delivery: { url: args.url } }); return out("UNSUBSCRIBED"); }
      const result = await events.subscribe({ ...scope, provider: "grok", delivery: { mode: "webhook", url: args.url, secret: args.secret }, contextReference: args.contextReference, ttlMs: args.ttlMs, signal: ctx.signal });
      return out("SUBSCRIBED", result);
    }
    const invoke = (operation, body, round, wait = 0) => relay({ operation, id: ids.id, keys, body, round, wait, signal: ctx.signal, agent: ctx.agent });
    const snapshot = await invoke("snapshot");
    if (snapshot.status === 404 && name !== "grill_send") return ended(snapshot);
    if (snapshot.status !== 404) check(snapshot);
    if (name === "grill_show") return out("VIEW", { round: snapshot.body.round, revision: snapshot.body.revision, viewLink: args.link });
    if (name === "grill_ui_state") {
      const r = args.afterRevision === undefined ? snapshot : await invoke("state", { afterRevision: args.afterRevision }, undefined, args.seconds ?? 25);
      if (r.status === 404) return ended(r); check(r);
      return r.status === 204 ? out("WAITING") : out("STATE", { snapshot: r.body });
    }
    if (name === "grill_ui_submit") {
      const { round, expectedRevision, submissionId, ct, iv } = args;
      const r = await invoke("answer", { expectedRevision, submissionId, ct, iv }, round);
      if (r.status === 404) return ended(r);
      if (r.status === 409) return out("CONFLICT"); check(r);
      return out("SUBMITTED", { round, submissionId });
    }
    if (name === "grill_send") {
      if ((args.grill === undefined) === (args.text === undefined) || (args.title !== undefined && typeof args.title !== "string") ||
        (args.text !== undefined && typeof args.text !== "string")) fail("INPUT");
      let grill;
      try {
        const converted = args.text !== undefined ? convert(args.text) : validateGrill(args.grill);
        if (!converted.ok) fail("INPUT");
        const validated = validateGrill({ ...converted.grill, ...(args.title !== undefined ? { title: args.title } : {}) });
        if (!validated.ok) fail("INPUT"); grill = validated.grill;
      } catch { fail("INPUT"); }
      if (grill.questions.some(question => !question.recommend)) fail("WORKFLOW");
      // The keyed digest binds domain, session, round AND original expected revision. It is
      // an opaque retry identity, not plaintext retention; randomized AES nonces stay intact.
      const operationId = crypto.createHmac("sha256", keys.writeToken).update("grill-me/hosted/publish/v1\0")
        .update(JSON.stringify([ids.id, args.round, args.expectedRevision, grill])).digest("base64url").slice(0, 16);
      let r;
      if (snapshot.status === 200 && snapshot.body.round === args.round && snapshot.body.operationId === operationId) r = snapshot;
      else {
        if (snapshot.status === 404) {
          if (snapshot.body?.reason || args.round !== 1 || args.expectedRevision !== 0) return ended(snapshot);
          const issuedAt = Buffer.from(ids.id, "base64url").readUInt32BE(0) * 1000;
          if (issuedAt > now() + 1000 || now() >= issuedAt + PREPARE_MS) return ended(snapshot);
          reserve(ids.id, ctx.conversation);
        } else if (snapshot.body.state !== "idle" || args.round !== snapshot.body.round + 1 || args.expectedRevision !== snapshot.body.revision) fail("CONFLICT");
        const blob = await sealRound(grill, { ...ids, round: args.round });
        r = await invoke(snapshot.status === 404 ? "create" : "publish", { id: ids.id, ...blob, round: args.round, operationId, expectedRevision: args.expectedRevision });
        // Concurrent identical calls may encrypt different random nonces. Only one wins;
        // recover the saved operation snapshot instead of replacing its ciphertext.
        if (r.status === 409) {
          const recovered = await invoke("snapshot");
          if (recovered.status === 200 && recovered.body.round === args.round && recovered.body.operationId === operationId) r = recovered;
        }
        if (r.status === 404) return ended(r); check(r);
      }
      return out(r.body.state === "idle" ? "IDLE" : "READY", { link: args.link, id: ids.id, round: r.body.round, revision: r.body.revision,
        state: r.body.state, count: grill.questions.length, expiresAt: r.body.expiresAt });
    }
    if (name === "grill_wait") {
      if (snapshot.body.round !== args.round) fail("CONFLICT");
      if (snapshot.body.state === "idle") return out("IDLE", { round: args.round, revision: snapshot.body.revision });
      {
        const r = await invoke("answers", null, args.round, (args.seconds ?? 45));
        if (r.status === 404) return ended(r); check(r);
        if (r.status === 204) return out("WAITING", { round: args.round });
        // Decrypt current question context from the same round snapshot, only in this call.
        const grill = await openRound(snapshot.body, { ...ids, round: args.round });
        const answers = await openRoundAnswers(r.body, grill, { ...ids, round: args.round });
        return out("ANSWERS", { answers: answerLines(grill, answers), receipt: { round: args.round, expectedRevision: r.body.revision, submissionId: r.body.submissionId },
          message: "Retain these answers, then call grill_ack with this exact receipt. Nothing has been cleared yet." });
      }
    }
    const body = name === "grill_ack" ? { expectedRevision: args.receipt.expectedRevision, submissionId: args.receipt.submissionId, ...(args.contextReceipt ? { contextReceipt: args.contextReceipt } : {}) } : { expectedRevision: args.expectedRevision };
    const operation = name === "grill_ack" ? "ack" : name === "grill_finish" ? "finish" : "cancel";
    const r = await invoke(operation, body, args.receipt?.round);
    if (r.status === 404) return ended(r);
    if (r.status === 409 && /checkpoint/.test(r.body?.error ?? "")) fail("CONTEXT");
    check(r);
    if (name === "grill_ack") {
      const current = await invoke("snapshot");
      return out("ACKNOWLEDGED", { round: args.receipt.round, ...(current.status === 200 ? { currentRound: current.body.round, revision: current.body.revision, state: current.body.state } : {}),
        next: "Use the collected answers to recompute the design-tree frontier. Continue with the next whole independent frontier on this SAME link; do not ask permission merely to continue grilling. Look up facts yourself and give every question a recommendation. Finish only when the frontier is empty and the user confirms shared understanding." });
    }
    return out(name === "grill_finish" ? "FINISHED" : "CANCELLED");
  }

  async function handle(req, res, url) {
    const receivedAt = performance.now();
    let modern = false;
    const response = (id, result) => ({ jsonrpc: "2.0", id, result: modern ? modernResult(result, version) : result });
    const headers = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" };
    const reply = (status, value) => { if (status >= 400) { req.resume(); res.setHeader("connection", "close"); }
      res.writeHead(status, headers); res.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (url.search) return reply(400, rpcError(null, -32600, "MCP URL must not contain query parameters"));
    if (req.headers.origin !== undefined && !ORIGINS.has(req.headers.origin)) { stat("hosted_rejected", "origin"); return reply(403); }
    if (req.method !== "POST") { res.setHeader("allow", "POST"); return reply(405); }
    if (req.headers["mcp-session-id"] !== undefined) return reply(400);
    const accept = String(req.headers.accept ?? "").toLowerCase().split(",").filter(s => {
      const q = /;\s*q\s*=\s*([\d.]+)/.exec(s); return !q || (Number(q[1]) > 0 && Number(q[1]) <= 1);
    }).map(s => s.trim().split(";")[0].trim());
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return reply(406);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) return reply(415);
    let message;
    try {
      if (Number(req.headers["content-length"] || 0) > 32768) return reply(413);
      message = await readMessage(req);
    } catch (e) { return reply(e.status ?? 400, rpcError(null, -32700, "Invalid or incomplete JSON body")); }
    if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
      ("id" in message && !(typeof message.id === "string" && message.id.length <= 128 || Number.isSafeInteger(message.id))) ||
      (message.params !== undefined && !object(message.params))) return reply(400, rpcError(null, -32600, "Invalid JSON-RPC request"));
    const protocol = modernRequest(req, message, [MODERN, ...VERSIONS]); modern = protocol.modern;
    if (protocol.error) return reply(400, { jsonrpc: "2.0", id: message.id ?? null, error: protocol.error });
    if (!modern && req.headers["mcp-protocol-version"] !== undefined && !VERSIONS.includes(req.headers["mcp-protocol-version"])) return reply(400);
    if (!("id" in message)) return ["notifications/initialized", "notifications/cancelled"].includes(message.method) ? reply(202) : reply(400);
    const { id, params = {}, method } = message;
    if (modern && method === "server/discover") return reply(200, response(id, { supportedVersions: [MODERN, ...VERSIONS], capabilities: { tools: {}, events: {}, resources: {} },
      instructions: CONTINUATION + HOSTED_INSTRUCTIONS, cacheScope: "public", ttlMs: 300_000 }));
    if (modern && method === "events/list") return reply(200, response(id, { events: [{ name: EVENT_NAME,
      description: "Current phone round's winning answer is ready. Wake this SAME subscribed interview chat, read/retain answers using its saved private link, ACK exact receipt, recompute frontier and publish next round. Payload is metadata only, not answer delivery.",
      delivery: ["webhook"], inputSchema: { type: "object", properties: { link: linkField }, required: ["link"], additionalProperties: false },
      payloadSchema: { type: "object", properties: { sessionId: field("Session ID"), round: field("Current round", "integer"), revision: field("Answered revision", "integer"), submissionId: field("Winning submission ID") },
        required: ["sessionId", "round", "revision", "submissionId"], additionalProperties: false },
    }] }));
    if (modern && ["events/subscribe", "events/unsubscribe"].includes(method)) {
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), Math.max(0, receivedAt + 15_000 - performance.now())); timer.unref();
      const disconnect = () => controller.abort(); res.once("close", disconnect);
      try {
        if (Object.keys(params).some(k => !["name", "arguments", "delivery", "ttlMs", "cursor", "_meta"].includes(k)) || params.name !== EVENT_NAME || !object(params.arguments) ||
          Object.keys(params.arguments).join() !== "link" || params.cursor !== undefined && params.cursor !== null || !object(params.delivery) ||
          Object.keys(params.delivery).some(k => !["mode", "url", "secret"].includes(k)) || params.delivery.mode !== "webhook") throw new Error("invalid");
        const ids = capability(params.arguments.link), keys = await deriveSessionKeys(ids.secret);
        const args = { sessionId: ids.id, authHash: keys.writeHash, preparedUntil: Buffer.from(ids.id, "base64url").readUInt32BE(0) * 1000 + PREPARE_MS,
          delivery: params.delivery, ttlMs: params.ttlMs, signal: controller.signal };
        const result = method === "events/subscribe" ? await events.subscribe(args) : events.unsubscribe(args);
        if (!res.destroyed) reply(200, response(id, result));
      } catch (e) {
        const reason = ["timeout", "challenge_failed", "blocked_address", "network", "redirect", "response_limit", "capacity", "conflict"].includes(e.reason) ? e.reason : "invalid_subscription";
        if (!res.destroyed) reply(200, { jsonrpc: "2.0", id, error: { code: reason === "invalid_subscription" ? -32602 : -32015, message: "Callback subscription unavailable", data: { reason } } });
      } finally { clearTimeout(timer); res.off("close", disconnect); controller.abort(); controllers.delete(controller); }
      return;
    }
    if (modern && ["initialize", "ping"].includes(method)) return reply(404, rpcError(id, -32601, "Method not found"));
    if (method === "initialize") {
      if (typeof params.protocolVersion !== "string" || !params.protocolVersion || params.protocolVersion.length > 64 || !object(params.capabilities) ||
        !object(params.clientInfo) || typeof params.clientInfo.name !== "string" || !params.clientInfo.name || params.clientInfo.name.length > 200 ||
        typeof params.clientInfo.version !== "string" || !params.clientInfo.version || params.clientInfo.version.length > 100)
        return reply(200, rpcError(id, -32602, "Invalid initialization parameters"));
      return reply(200, response(id, { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }, serverInfo: { name: "grill-me-hosted", version }, instructions: HOSTED_INSTRUCTIONS + "\n\n" + CONTINUATION }));
    }
    if (method === "ping") return reply(200, response(id, {}));
    if (method === "tools/list") return reply(200, response(id, { tools: TOOLS, ...(modern ? { cacheScope: "public", ttlMs: 300_000 } : {}) }));
    if (method === "resources/list") return reply(200, response(id, { resources: [{ uri: resource.uri, name: "Grill Me swipe cards", mimeType: resource.mimeType, _meta: resource._meta }], ...(modern ? { cacheScope: "public", ttlMs: 300_000 } : {}) }));
    if (method === "resources/read") {
      if (params.uri !== resource.uri) return reply(200, rpcError(id, -32602, "Unknown resource"));
      // The cached public template is ~640KB. Bound copies and slow readers separately
      // from tiny metadata calls; never allocate an unbounded queue of serialized HTML.
      if (now() - resourceWindow >= 60_000) { resourceWindow = now(); resourceRequests = 0; }
      if (resourceReads >= 4 || resourceRequests >= 60) return reply(429, rpcError(id, -32015, "Resource capacity reached"));
      resourceReads++; resourceRequests++;
      let released = false;
      const release = () => { if (released) return; released = true; resourceReads--; clearTimeout(timer); res.off("finish", release); res.off("close", release); };
      const timer = setTimeout(() => { res.destroy(); release(); }, 10_000); timer.unref();
      res.once("finish", release); res.once("close", release);
      return reply(200, response(id, { contents: [resource], ...(modern ? { cacheScope: "public", ttlMs: 300_000 } : {}) }));
    }
    if (method !== "tools/call") return reply(modern ? 404 : 200, rpcError(id, -32601, "Method not found"));
    const tool = TOOLS.find(t => t.name === params.name);
    if (!tool) return reply(200, rpcError(id, -32602, "Unknown tool"));
    let args = params.arguments === undefined ? {} : params.arguments;
    try { validateArgs(tool, args); } catch { return reply(200, response(id, { isError: true, content: [{ type: "text", text: safeMessages.INPUT }] })); }
    const controller = new AbortController(); controllers.add(controller);
    const budget = tool.name === "grill_wait" ? (args.seconds ?? 45) * 1000 : tool.name === "grill_ui_state" ? (args.seconds ?? 25) * 1000 + 1000 : 15_000;
    const deadline = receivedAt + budget;
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now())); timer.unref();
    const disconnect = () => controller.abort(); res.once("close", disconnect);
    const sse = tool.name === "grill_wait" || tool.name === "grill_ui_state";
    if (sse) { res.writeHead(200, { ...headers, "content-type": "text/event-stream", "x-accel-buffering": "no" }); res.flushHeaders(); res.write(": connected\n\n"); }
    const keepalive = sse ? setInterval(() => { if (!res.destroyed) res.write(": keepalive\n\n"); }, 10_000) : null;
    keepalive?.unref();
    let abortListener, ownsWait = false;
    try {
      if (performance.now() >= deadline) { controller.abort(); throw new Error("aborted"); }
      if (sse) {
        if (waits >= maxWaits) { stat("hosted_rejected", "waits"); fail("LIMIT"); }
        waits++; ownsWait = true;
      }
      const rawConversation = params._meta?.["openai/session"];
      const conversation = typeof rawConversation === "string" && rawConversation.length > 0 && rawConversation.length <= 512
        ? crypto.createHash("sha256").update(rawConversation).digest("hex") : null;
      const value = await Promise.race([
        call(tool.name, args, { signal: controller.signal, deadline, conversation, agent: /claude/i.test(req.headers["user-agent"] ?? "") ? "claude-ai" : /chatgpt|openai/i.test(req.headers["user-agent"] ?? "") ? "chatgpt" : "other" }),
        new Promise((_, reject) => { abortListener = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })); controller.signal.addEventListener("abort", abortListener, { once: true }); }),
      ]);
      // Some hosts expose only text content to their model. Include the exact capability,
      // state and ACK receipt there as well as structuredContent; PREPARED is never ready.
      const view = value.viewLink; delete value.viewLink;
      const text = value.status === "VIEW" ? "Interactive cards are available in supporting hosts. Otherwise use the SAME private phone link already returned by grill_send. No answers have been collected."
        : value.status === "PREPARED"
        ? `STATUS: PREPARED\n${JSON.stringify({ ...value, grillingInstructions: undefined })}\n\nRead and follow this complete grilling workflow BEFORE drafting questions:\n\n${value.grillingInstructions}\n\nPrivate capability only: publish the first round before showing the phone as ready.`
        : value.status === "ANSWERS" ? `${value.answers}\nSTATUS: ANSWERS\nACK receipt: ${JSON.stringify(value.receipt)}\n${value.message}`
        : `STATUS: ${value.status}\n${JSON.stringify(value)}${value.status === "PREPARED" ? "\nPrivate capability only: publish the first round before showing the phone as ready." : ""}` +
          (value.status === "READY" ? "\nShow the complete questions, then:\nGrill it on your phone\n" + value.link + (value.round === 1 ? "\n" + INLINE_GUIDANCE : "") : "");
      const body = response(id, { content: [{ type: "text", text }], structuredContent: value, ...(view ? { _meta: { "ai.grill-me/view": { link: view } } } : {}) });
      if (!res.destroyed) sse ? res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`) : reply(200, body);
    } catch (e) {
      const timed = controller.signal.aborted && ["grill_wait", "grill_ui_state"].includes(tool.name);
      const value = timed ? out("WAITING", { round: args.round }) : null;
      const body = response(id, timed ? { content: [{ type: "text", text: "STATUS: WAITING. Call again with the same link and round." }], structuredContent: value }
        : { isError: true, content: [{ type: "text", text: safeMessages[e?.safeCode] ?? safeMessages.UNAVAILABLE }] });
      if (!res.destroyed) sse ? res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`) : reply(200, body);
    } finally {
      clearTimeout(timer); if (keepalive) clearInterval(keepalive);
      controller.signal.removeEventListener("abort", abortListener); res.off("close", disconnect);
      if (ownsWait) waits--;
      controller.abort(); controllers.delete(controller); args = null; message = null;
    }
  }
  return { handle, stats: () => { prune(); return { creates: creates.size, createLimit: maxCreates, createHeadroom: Math.max(0, maxCreates - creates.size), waits, waitLimit: maxWaits, waitHeadroom: Math.max(0, maxWaits - waits), conversations: conversations.size }; },
    close: () => { for (const controller of controllers) controller.abort(); } };
}
