---
name: grill-me
description: Turn a batch of questions for the user into swipe cards on their phone. Use whenever you are about to ask the user two or more questions — decisions, choices, clarifications, approvals. You print one short link and a QR code; the user answers by swiping; the answers arrive back in this session. End-to-end encrypted, nothing to install for the user. For a single question, just ask it in the chat.
---

# Grill Me — questions to phone, answers to session

When you have **two or more questions** for the user, send them as a grill with the `grill_send`
MCP tool: the user answers by swiping on their phone, and the answers come back as the `grill_wait`
result. One question only: just ask it in the chat, no grill.

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
