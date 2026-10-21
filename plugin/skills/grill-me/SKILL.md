---
name: grill-me
description: Send questions as encrypted swipe cards on the user's phone. Use when the user explicitly asks to be grilled or to use Grill Me, or when you need to ask two or more questions. An explicit grill request also applies to one question; otherwise ask a single question in the conversation.
---

# Grill Me — questions to phone, answers to session

When the user explicitly asks to be grilled or to use Grill Me, send a grill with the CLI below.
If the topic needs clarification, put that clarification in the grill rather than asking it in
the terminal first. A single question is enough for an explicit request; do not invent extra questions.

Otherwise, use a grill when you have **two or more questions** for the user. Ask an ordinary single
question in the terminal. The user answers on their phone, and the answers come back as the command's output.

## 1. Follow Matt Pocock’s complete grilling skill

Read [references/grilling.md](references/grilling.md) and follow it in full. It is the original
skill, bundled unchanged: design tree, frontier rounds, recommendations, exact question format,
fact-finding, recomputing the frontier after answers, and confirmation of shared understanding
before acting. Do not substitute a generic batch of questions or a summary of the workflow.

Use Matt’s format in the visible chat reply and send exactly that same round to the phone.
Continue question numbering across rounds. The phone link supplements the round; it does not
replace the questions in chat. Only send ready frontier questions, never questions whose answers
depend on other unresolved questions in this round.

## 2. Send the grill

Pipe exactly the questions (not your whole reply) to `send` with a heredoc — no temp file:

```bash
npx -y grill-me-ai send --session - <<'EOF'
❓ Q1 - …
EOF
```

Show all the formatted questions in your reply, then end with:

```text
Grill it on your phone
<the returned link>
```

Use the real link as plain text, without a code block. Do not print a QR code. Keep the `id`
for subsequent rounds, `cancel`, `finish` and `fetch`; it is not part of the user-facing footer.
Publish each subsequent ready frontier with `send --id <id> --round <next-number> -`, piping
the full new questions as before. Reuse that explicit interview identity; never a global/latest
session. The open phone waits and updates automatically at the same link. Keep every round
fully visible in chat. On `STATUS: PUBLISHING`, the upload is UNCONFIRMED: retry the exact
returned id/round and same questions; do not claim readiness or create another session.

## 3. Wait for the answers in the background

Run `npx -y grill-me-ai wait <id>` **as a background command** and end your turn. Claude Code wakes
you when it exits, with the answers as its output.

## 4. If the user answers in the terminal first

Stop the background wait and run `npx -y grill-me-ai cancel <id>`.

## 5. Read the status line

`wait`/`fetch` always end with one `STATUS:` line:

- `STATUS: ANSWERS` — the lines above it are the answers: `Q<n> - agree` (the ➡️), `Q<n> - <choice
  name>`, `Q<n> - skip for now, ask again later`, or the user's own words. Carry on with them.
- `STATUS: IDLE` — the round was collected. Publish the next ready frontier with the saved
  id and next round number, or finish after shared-understanding confirmation.
- `STATUS: EXPIRED` — offer a new session for the current frontier, without claiming that
  old phone drafts/history resume. Sessions are not resent with the one-shot `resend` command.
- `STATUS: OFFLINE` — say "Couldn't reach grill-me.ai. Paste the answers from Copy answers, or say
  'check grill'." On "check grill", run `npx -y grill-me-ai fetch <id>`.
- `STATUS: WAITING` (fetch only) — no answers yet; wait or check again later.

## 6. Outside Claude Code

No background commands there: use the MCP tools `grill_send` and `grill_wait` if they are available,
with the same format and status mapping. Pass `session:true`, retain the explicit id, and
publish the next round with that id and round number; use `grill_finish` to end an idle session.

After Matt's shared-understanding confirmation, run `npx -y grill-me-ai finish <id>`.
It refuses pending questions/uncollected answers; cancel explicitly aborts the current round.
The relay/phone retain only the current round; interview history stays in the conversation.

## Timeout and resume recovery

The background CLI wait has **no fixed total timeout**; each network poll lasts at most 50 seconds. Claude Code can stop its background task independently. For MCP, use the actual configured limit advertised by the tool (generic default45 seconds; Claude Desktop bundle180 seconds).

Before waiting, tell the user: **If the agent stops waiting, type `Resume Grill Me` in this same chat.** A wait timeout does not expire the interview. Pending questions expire one hour after publication, and uncollected answers one hour after submission; opening the page does not extend this.

On `Resume Grill Me` (or `resume` in this interview), check the saved id first: `grill_wait` with `seconds:1`, or CLI `fetch <id>`. Retain returned answers before normal collection/acknowledgement, then continue the frontier. If still pending, keep the same id, link, question numbers and partial draft; do not send a replacement round. If idle, use already collected answers in this conversation to prepare the next frontier. If expired, resend only the last unanswered frontier from this conversation into a fresh session and show its new link; do not claim the expired page will update. An explicitly finished/cancelled interview stays ended. If context is missing, ask for the copied answers/questions instead of guessing. Offline or an unconfirmed publication is not expiry: retry its saved identity/exact request.

Copy answers is a manual fallback: the user can paste the current answers into this conversation. It does not prove automatic delivery. Never ask the user to change to a new interview merely because one wait timed out.

## Credit and source

Original skill by [Matt Pocock](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/productivity/grilling/SKILL.md), MIT licensed.
The complete source is vendored unchanged in `references/grilling.md`, pinned to
`49dd158d1076134a641b33efb035946536778336`; `references/UPSTREAM.json` records the source hash and
`references/LICENSE` preserves the upstream notice. Grill Me adds phone delivery around it.
