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

**Also show the questions in your reply as usual**, so the user can answer in the terminal instead.

## 2. Send the grill

Pipe exactly the questions (not your whole reply) to `send` with a heredoc — no temp file:

```bash
npx -y grill-me-ai send - <<'EOF'
❓ Q1 - …
EOF
```

Show all the formatted questions in your reply, then end with:

```text
Grill it on your phone
<the returned link>
```

Use the real link as plain text, without a code block. Do not print a QR code. Keep the `id`
for `cancel`, `resend` and `fetch`; it is not part of the user-facing footer.

## 3. Wait for the answers in the background

Run `npx -y grill-me-ai wait <id>` **as a background command** and end your turn. Claude Code wakes
you when it exits, with the answers as its output.

## 4. If the user answers in the terminal first

Stop the background wait and run `npx -y grill-me-ai cancel <id>`.

## 5. Read the status line

`wait`/`fetch` always end with one `STATUS:` line:

- `STATUS: ANSWERS` — the lines above it are the answers: `Q<n> - agree` (the ➡️), `Q<n> - <choice
  name>`, `Q<n> - skip for now, ask again later`, or the user's own words. Carry on with them.
- `STATUS: EXPIRED` — say "The grill expired. Want me to send it again?" and run
  `npx -y grill-me-ai resend <id>` on yes (new link, the phone keeps its progress).
- `STATUS: OFFLINE` — say "Couldn't reach grill-me.ai. Paste the answers from Copy answers, or say
  'check grill'." On "check grill", run `npx -y grill-me-ai fetch <id>`.
- `STATUS: WAITING` (fetch only) — no answers yet; wait or check again later.

## 6. Outside Claude Code

No background commands there: use the MCP tools `grill_send` and `grill_wait` if they are available,
with the same format and status mapping.

## Credit

Question format adapted from [Matt Pocock’s grilling skill](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling),
MIT licensed. Phone delivery and this client workflow are Grill Me adaptations.
