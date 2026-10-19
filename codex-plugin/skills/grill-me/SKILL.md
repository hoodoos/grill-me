---
name: grill-me
description: Send questions as encrypted swipe cards on the user's phone. Use when the user explicitly asks to be grilled or to use Grill Me, or when you need to ask two or more questions. An explicit grill request also applies to one question; otherwise ask a single question in the conversation.
---

# Grill Me — questions to phone, answers to session

When the user explicitly asks to be grilled or to use Grill Me, call `grill_send`. If the topic
needs clarification, put that clarification in the grill rather than asking it in chat first.
A single question is enough for an explicit request; do not invent extra questions to reach a minimum.

Otherwise, use `grill_send` when you have **two or more questions** for the user. Ask an ordinary
single question in chat. The user answers the grill on their phone; collect those answers with `grill_wait`.

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

Start the interview with `grill_send` using `session:true` and exactly the questions
(not your whole reply) as `text`. Retain its explicit `id` and `round` for this interview.
For each subsequent ready frontier, call `grill_send` with that same `id`, `session:true`,
the next `round` and the full new questions as `text`. Never attach an unrelated interview
to a global/latest session. The open phone waits and updates on the same link automatically.
Show all the
formatted questions in your reply, then end with:

```text
Grill it on your phone
<the returned link>
```

Use the real link as plain text, without a code block. Do not print a QR code. Keep the `id`
for `grill_wait`, subsequent rounds, `grill_finish` and `grill_cancel`; it is not part of the user-facing footer.
On `PUBLISHING`, the upload is UNCONFIRMED: retry the exact returned id/round and same questions.
Do not claim the phone is ready or create another session to recover an ambiguous upload.

## 3. Wait for the answers

Call `grill_wait` with the `id`. It waits for the answers and returns a status:

- `ANSWERS` — the answer lines follow: `Q<n> - agree` (the ➡️), `Q<n> - <choice name>`,
  `Q<n> - skip for now, ask again later`, or the user's own words. Carry on with them.
- `WAITING` — no answers yet. Call `grill_wait` again with the same arguments.
- `IDLE` — this round has been collected. Compute and publish the next ready frontier using
  the same id and the next round number, or finish after the required confirmation.
- `EXPIRED` — the session ended or expired. Offer a new session for the current frontier;
  do not claim that the old phone draft or history will resume.
- `OFFLINE` — say "Couldn't reach grill-me.ai. Paste the answers from Copy answers, or say 'check
  grill'." On "check grill", call `grill_wait` again.

## 4. If the user answers in the chat first

Call `grill_cancel` with the `id` and carry on with what they said.

After Matt's shared-understanding confirmation, call `grill_finish` with this id. It refuses
pending questions and uncollected answers. Cancellation explicitly aborts any current round.
The relay and phone keep only the current round, not the interview history; retain history
in the agent conversation. Ordinary API/CLI one-shot calls remain compatible.

## Credit and source

Original skill by [Matt Pocock](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/productivity/grilling/SKILL.md), MIT licensed.
The complete source is vendored unchanged in `references/grilling.md`, pinned to
`49dd158d1076134a641b33efb035946536778336`; `references/UPSTREAM.json` records the source hash and
`references/LICENSE` preserves the upstream notice. Grill Me adds phone delivery around it.
