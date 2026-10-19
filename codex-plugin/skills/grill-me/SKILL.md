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

## 1. Write the questions in the grill text format

All open questions go in **one message**, each gets a ➡️ recommendation, and numbering continues
across rounds (Q11, Q12, …). The format, word for word:

```
❓ Q<n> - <title>
<self-contained body; choices as bullets that start with a **bold short name**, never lettered>
➡️ <the recommended choice, and why in a few words>

---
```

- The title stays on the `❓` line; the body starts on the next line and is self-contained.
- Choices are bullets like `- **Parsed**: parse locally, upload structured questions.` Never (a)/(b).
- Every question ends with its `➡️` line, and a `---` line separates questions.

**Also show the questions in your reply as usual**, so the user can answer in the chat instead.

## 2. Send the grill

Call `grill_send` with exactly the questions (not your whole reply) as `text`. From its result,
put **the link on its own line as plain text** in your reply (so it's clickable wherever markdown
renders), and **the QR inside a code block**. Keep the `id`: `grill_wait` and `grill_cancel` need it.

## 3. Wait for the answers

Call `grill_wait` with the `id`. It waits for the answers and returns a status:

- `ANSWERS` — the answer lines follow: `Q<n> - agree` (the ➡️), `Q<n> - <choice name>`,
  `Q<n> - skip for now, ask again later`, or the user's own words. Carry on with them.
- `WAITING` — no answers yet. Call `grill_wait` again with the same arguments.
- `EXPIRED` — say "The grill expired. Want me to send it again?" and on yes call `grill_send`
  with the same questions (new link, the phone keeps its progress).
- `OFFLINE` — say "Couldn't reach grill-me.ai. Paste the answers from Copy answers, or say 'check
  grill'." On "check grill", call `grill_wait` again.

## 4. If the user answers in the chat first

Call `grill_cancel` with the `id` and carry on with what they said.
