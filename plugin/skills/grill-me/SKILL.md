---
name: grill-me
description: Turn a batch of questions for the user into swipe cards on their phone. Use whenever you are about to ask the user two or more questions — decisions, choices, clarifications, approvals. You print one short link and a QR code; the user answers by swiping; the answers arrive back in this session. End-to-end encrypted, nothing to install for the user. For a single question, just ask it in the terminal.
---

# Grill Me — questions to phone, answers to session

When you have **two or more questions** for the user, send them as a grill: the user answers by
swiping on their phone, and the answers come back as your command's output. One question only:
just ask it in the terminal, no grill.

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

Put **the link from its output on its own line as plain text** in your reply (so it's clickable
wherever markdown renders), and **the QR inside a code block**. Keep the `id`: `cancel`, `resend`
and `fetch` need it.

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
