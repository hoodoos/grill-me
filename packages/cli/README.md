# grill-me-ai

Your coding agent has questions. Grill Me turns them into swipe cards on your phone. Your answers
go straight back into the agent's session, and **grill-me.ai can't read any of it** — the grill and
the answers are end-to-end encrypted with a key that only lives in the link.

```
npx -y grill-me-ai send questions.md   # converts, encrypts, uploads; prints a link and a QR code
npx -y grill-me-ai wait <id>           # long-polls until the answers arrive, then deletes the grill
```

Commands: `send [file|-]`, `wait <id>`, `fetch <id>` (check once), `resend <id>` (expired grill, new
link, the phone keeps its progress), `cancel <id>`. `--server URL` works everywhere; state lives in
`~/.grill-me` (override with `GRILL_ME_HOME`).

Accepted input: the internal grill JSON, grill text (`❓ Q1 - title`, body, `➡️ recommendation`),
Claude AskUserQuestion or Codex request_user_input JSON, or numbered markdown.

Subpath exports: `grill-me-ai/core` (format, converters, crypto, answer lines — used by Agent Hub)
and `grill-me-ai/ui` (the swipe cards).

MIT licensed. <https://github.com/hoodoos/grill-me>
