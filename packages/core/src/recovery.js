import { answerLines } from "./answers.js";
// Transport recovery rules; the relay still retains only the current round.
export const RESUME_COMMAND = "Resume Grill Me";
export const EXPIRY_HELP = "Questions expire 1 hour after publication; uncollected answers expire 1 hour after submission. Collection refreshes the idle session for 1 hour. Opening or polling the page does not extend this.";
export const RESUME_HELP = 'If the agent stops waiting or the next round does not arrive, type "Resume Grill Me" in the SAME agent chat. Copy answers is a manual fallback, not proof the agent received them.';
export const RESUME_WORKFLOW = 'Treat "Resume Grill Me" (or "resume" in an active grilling conversation) as a recovery request, not a new unrelated interview. First check the saved interview for answers: hosted tools use grill_wait for the saved round with seconds:1; local MCP uses grill_wait with the saved id and seconds:1; CLI uses fetch with the saved id. ANSWERS: retain them before the normal collection acknowledgement and recompute the next frontier. WAITING/pending: keep the SAME link, round and partial draft; keep an already-open view. Reopen with grill_show only if that view is closed or unusable, on this explicit resume request; warn that an unsent draft in an old embedded view must be copied before closing it because a new embedded view cannot inherit its memory. Never replace pending questions. IDLE: use answers already retained in this chat to recompute the next frontier, not resend collected questions. EXPIRED/ENDED: finished or cancelled interviews stay ended; only expiry/unknown absence permits a fresh session and resending the last UNANSWERED frontier from this chat, preserving question numbers. Give the fresh link; the expired page cannot update itself. If the last frontier or answers are missing from chat, say so and ask the user to paste Copy answers or the questions; do not invent them. OFFLINE/conflict/unconfirmed publication: retry the saved identity or exact publication, never fork speculatively. Never ACK before retaining actual answers, and never claim a resumed model turn or automatic wake is guaranteed.';
export function waitHelp(seconds) {
  const n = Math.max(1, Math.floor(seconds));
  const duration = n % 60 === 0 ? `${n / 60} minute${n === 60 ? "" : "s"}` : `${n} second${n === 1 ? "" : "s"}`;
  return `This answer wait lasts up to ${duration} per call. A wait timeout does not expire the interview. ${RESUME_HELP}`;
}

// Manual recovery includes the unfinished editor/choice draft without committing it or
// misrepresenting it as a submitted answer. Normal send validation is unchanged.
export function draftLines(grill, snapshot) {
  return answerLines(grill, { v: 1, answers: grill.questions.map((q, i) => {
    const draft = snapshot?.drafts?.[i];
    if (typeof draft === "string") return draft.trim() ? { n: q.n, kind: "own", text: draft.trim() } : { n: q.n, kind: "skip" };
    const choices = snapshot?.choiceDrafts?.[i];
    if (q.multi && Array.isArray(choices)) {
      const names = choices.filter(name => q.choices.some(choice => choice.name === name));
      return names.length ? { n: q.n, kind: "choice", choice: names } : { n: q.n, kind: "skip" };
    }
    return { ...(snapshot?.answers?.[i] ?? { kind: "skip" }), n: q.n };
  }) });
}
