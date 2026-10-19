import { App } from "@modelcontextprotocol/ext-apps";
import { mountGrill } from "../../ui/src/grill.js";
import { parseSessionLink, openRound, sealRoundAnswers } from "../../core/src/session.js";
import { newId, isId } from "../../core/src/crypto.js";

const app = new App({ name: "Grill Me", version: "0.2.0" }, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: false });
const $ = id => document.getElementById(id);
let ids, link, started = false, alive = true, generation = 0, revision = -1, round = 0;
let ui, grill, draft, intent, confirmed = false, notice, notifyingNotice, retryAction;
let pollController;
let lostRound = 0; // current-only loss notice; never misrepresent another winner as ours
function retire() {
  try { ui?.destroy(); } catch {} ui = null;
  const old = $("grill-root"), fresh = old.cloneNode(false); fresh.removeAttribute("class"); old.replaceWith(fresh);
}
function message(text) {
  retire(); $("cards").hidden = true; $("status").hidden = false; $("status").textContent = text;
}
function retry(fn) { retryAction = fn; $("retry").hidden = !fn; }
$("retry").onclick = () => { const fn = retryAction; retry(null); if (fn) void fn(); };
function end(reason) {
  if (!alive) return; alive = false; generation++; pollController?.abort();
  ids = link = grill = draft = intent = notice = null; lostRound = 0; retry(null);
  message({ finished: "All done—your agent has finished this grill.", cancelled: "This grill was cancelled.", expired: "This session expired." }[reason] ?? "Session ended or expired.");
}
async function tool(name, args, signal) {
  const result = await app.callServerTool({ name, arguments: args }, { timeout: 30_000, signal });
  if (result.isError || !result.structuredContent) throw new Error("unavailable");
  return result.structuredContent;
}
function winningNotice(winner) {
  // Only authenticated relay results call this. Notification identity is the actual
  // winner, not this view's (possibly losing) encrypted submission intent.
  if (winner.round !== round || !isId(winner.submissionId)) throw new Error("Invalid winner.");
  if (notice?.round !== winner.round || notice.submissionId !== winner.submissionId)
    notice = { round: winner.round, submissionId: winner.submissionId, notified: false };
}
function deliveryLabel() {
  if (lostRound === round) return "Another submission won this round. Your answers were not delivered.";
  if (confirmed && intent?.submissionId === notice?.submissionId) return "Sent.";
  return "This round was submitted from another view.";
}
async function notify() {
  if (!alive || !notice || notice.notified || notifyingNotice === notice) return;
  const g = generation, saved = notice;
  if (!app.getHostCapabilities()?.message?.text) {
    message(deliveryLabel() + " This host cannot request an automatic follow-up here. The submitted answers remain safe for your agent to collect."); retry(notify); return;
  }
  notifyingNotice = saved;
  try {
    // Metadata only. The model already owns the private link; never include its key,
    // questions, answers or a replacement ACK in this user-origin follow-up.
    const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: `Grill Me answers available for session ${ids.id}, round ${saved.round}, submission ${saved.submissionId}: the server-confirmed winning submission, possibly from the phone or another view. Use the saved private interview link to grill_wait ONCE with seconds:1, read and retain the actual winning answers, then ACK its exact receipt and continue the Matt frontier on the SAME view. After publishing, end your turn for the next input. Finish only after shared-understanding confirmation. This notification is not an ACK or a claim that this view submitted the answers.` }] }, { timeout: 15_000 });
    if (result.isError) throw new Error("rejected");
    if (!alive || g !== generation || saved !== notice) return;
    saved.notified = true; retry(null);
  } catch {
    if (alive && g === generation && saved === notice) {
      message(deliveryLabel() + " The host follow-up was not confirmed. Retry the follow-up; the submitted answers have not been cleared."); retry(notify);
    }
  } finally { if (notifyingNotice === saved) notifyingNotice = null; }
}
async function submitIntent() {
  const saved = intent, g = generation;
  if (!saved || !alive) throw new Error("Round moved on.");
  const result = await tool("grill_ui_submit", { link, ...saved });
  if (!alive || g !== generation || saved !== intent) return;
  if (result.status === "ENDED") { end(result.reason); return; }
  if (result.status !== "SUBMITTED") {
    lostRound = saved.round; intent = null; confirmed = false; generation++; grill = draft = null;
    message("Another submission won this round. Your answers were not delivered. Waiting for your agent."); return;
  }
  generation++; // retired onChange/swipe callbacks cannot recreate purged plaintext
  confirmed = true; grill = draft = null; retry(null);
  winningNotice(result);
  message("Sent. Waiting for your agent to pick up your answers.");
  void notify(); // host message latency must not block current-state polling
}
async function send(answers) {
  const g = generation;
  if (!intent) {
    const savedRound = round, savedRevision = revision;
    const blob = await sealRoundAnswers(answers, grill, { ...ids, round });
    if (!alive || g !== generation) throw new Error("Round moved on.");
    intent = { round: savedRound, expectedRevision: savedRevision, submissionId: newId(), ...blob };
  }
  // Retain the exact encrypted intent on a lost reply. Never reseal a retry.
  await submitIntent();
}
async function accept(snapshot) {
  if (!alive || !snapshot || snapshot.v !== 2 || snapshot.id !== ids.id || !Number.isInteger(snapshot.revision) || snapshot.revision < revision || snapshot.round < round) return;
  if (snapshot.revision === revision) return; // stale/repeated results never remount a partial draft
  const oldRound = round; revision = snapshot.revision; round = snapshot.round;
  if (snapshot.state === "pending") {
    generation++; const g = generation; retire();
    if (oldRound !== round) draft = null;
    intent = notice = null; lostRound = 0; confirmed = false; retry(null);
    const decoded = await openRound(snapshot, { ...ids, round });
    if (!alive || g !== generation) return;
    grill = decoded; $("status").hidden = true; $("cards").hidden = false;
    ui = mountGrill($("grill-root"), { grill, saved: draft,
      onChange: snap => { if (alive && generation === g) draft = snap; },
      onSend: answers => { if (!alive || generation !== g) throw new Error("Round moved on."); return send(answers); },
    });
  } else if (snapshot.state === "answered") {
    if (intent && intent.round === round && intent.submissionId === snapshot.submissionId) {
      if (!confirmed) { try { await submitIntent(); } catch { retry(submitIntent); } }
    } else { if (intent?.round === round) lostRound = round; generation++; grill = draft = intent = null; message(lostRound === round
      ? "Another submission won this round. Your answers were not delivered. Waiting for your agent."
      : "This round was submitted from another view. Waiting for your agent to collect it."); }
    winningNotice(snapshot);
    void notify();
  } else if (snapshot.state === "idle") {
    generation++; intent = grill = draft = notice = null; lostRound = 0; confirmed = false; retry(null);
    message("Your agent is thinking. Your next questions will appear here automatically.");
  }
}
async function poll() {
  while (alive) {
    try {
      pollController = new AbortController();
      const result = await tool("grill_ui_state", { link, ...(revision >= 0 ? { afterRevision: revision, seconds: 25 } : {}) }, pollController.signal);
      if (!alive) return;
      if (result.status === "ENDED") { end(result.reason); return; }
      if (result.status === "STATE") await accept(result.snapshot);
    } catch {
      if (!alive) return;
      if (ui) ui.setNote("Connection interrupted. Your current draft is kept in this open view.");
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
}
function dimensions(context = app.getHostContext()) {
  const d = context?.containerDimensions;
  const height = d?.height ?? d?.maxHeight;
  document.documentElement.style.setProperty("--host-height", Number.isFinite(height) && height > 0 ? `${height}px` : "100dvh");
  // maxHeight is permission to request a bounded size, not proof that the host has
  // already allocated it. A sandbox may initially be150px tall.
  if (Number.isFinite(d?.maxHeight) && d.maxHeight > 0) app.sendSizeChanged({ height: d.maxHeight });
  $("expand").hidden = !context?.availableDisplayModes?.includes("fullscreen") || context?.displayMode === "fullscreen";
}
$("expand").onclick = () => { void app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {}); };
app.onhostcontextchanged = context => dimensions({ ...app.getHostContext(), ...context });
app.ontoolresult = result => {
  // Ignore input/partial notifications entirely. A valid COMPLETED render result is
  // the sole capability handoff. Re-delivery must not reset this view's current draft.
  if (started || result.isError || result.structuredContent?.status !== "VIEW") return;
  const privateLink = result._meta?.["ai.grill-me/view"]?.link;
  try {
    const parsed = parseSessionLink(privateLink), url = new URL(privateLink);
    if (url.origin !== "https://grill-me.ai" || url.search !== "?session=2") return;
    ids = parsed; link = privateLink;
  } catch { return; }
  started = true;
  if (!app.getHostCapabilities()?.serverTools) { message("This host cannot connect the interactive cards. Use the same phone link already shown in chat."); return; }
  void poll();
};
app.onteardown = async () => { end(); return {}; };
app.connect().then(() => dimensions()).catch(() => message("This host could not connect the interactive view. Use the same phone link in chat."));
