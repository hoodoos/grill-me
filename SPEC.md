# Grill Me — spec

Your coding agent has questions. Grill Me turns them into swipe cards on your phone. Your answers go straight back
into the agent's session, and **grill-me.ai can't read any of it**.

It's a free, open-source taster for Agent Hub: the same grill UI, without accounts.

## Goals

- An agent with 2+ questions prints **one short link and the same link as a QR code**. You open it on any device
  and answer by swiping. The answers arrive in the agent's session within a second.
- **End-to-end encrypted.** The server stores only encrypted data, and the key never reaches it.
- **Kept only as long as needed.** A grill is deleted once the agent has its answers, and an unanswered grill
  after about an hour.
- **No accounts and no setup.** `npx grill-me-ai`, a Claude Code plugin, or an MCP server.
- **Any question format in, one internal format out.**
- **Cheap to run.** One small Node server.

Not goals: accounts, history, sharing grills with other people, push notifications (that's Agent Hub).

## How it works

```
agent machine                          grill-me.ai                         phone
─────────────                          ───────────                         ─────
grill-me send ── encrypted grill ──▶   stores encrypted data (≤ 1 h)
  prints link + QR                                                          opens link/QR
grill-me wait ── long poll ─────────▶  holds the request (≤ 50 s)  ◀── GET  decrypts, swipes
                                                                            (progress in localStorage)
              ◀── encrypted answers ── answers the open request    ◀── POST encrypted answers
prints answers into the session
DELETE ─────────────────────────────▶  deletes grill + answers
```

## Link and keys

- Link: `https://grill-me.ai/g/<id>#<secret>`
  - `id`: 12 random bytes, base64url (16 chars). The agent picks it, because the blob's AAD needs the `id` before
    upload. The server rejects any `id` that isn't exactly 16 base64url characters and answers `409` if it's
    taken; the agent then picks a new one.
  - `secret`: 16 random bytes, base64url (22 chars). The agent creates it. It sits after `#`, so browsers
    never send it to the server.
  - The whole link is about 60 characters, which makes a small QR code that's easy to scan from a terminal.
- Two keys come from the `secret`, using HKDF-SHA256 with an empty salt (Web Crypto, so the same code runs in
  Node and browsers). Test vectors are in `packages/core/test/fixtures/crypto-vectors.json`:
  - `encKey` = HKDF(secret, info `grill-me/v1/enc`): AES-256-GCM. Each blob gets a random 12-byte IV, and the
    AAD is `id + ":grill"` or `id + ":answers"`, so a blob can't be moved to another grill or slot.
  - `writeToken` = HKDF(secret, info `grill-me/v1/write`), 32 bytes. When the grill is created, the server
    receives only `SHA-256(writeToken)` (`writeHash`, both base64url). Posting answers and deleting the grill both
    need the token itself.
- Anyone with the full link can read and answer the grill. Anyone with only the `id` gets encrypted data they
  can't read, and can't post answers.

## Internal format (`grill-me-ai/core`)

```jsonc
// Grill: what gets encrypted and uploaded
{
  "v": 1,
  "title": "Grill Game design",            // optional
  "questions": [{
    "n": 14,                                // keeps the agent's numbering (it continues across rounds)
    "title": "What the agent uploads",
    "body": "Self-contained text. **bold** and `code` only.",
    "choices": [{ "name": "Parsed", "detail": "Parse locally, upload structured questions." }],
    "recommend": { "choice": "Parsed", "why": "errors stay where the agent can fix them" }, // choice may be null
    "multi": false                          // true = several choices allowed
  }]
}

// Answers: what the phone encrypts and posts
{ "v": 1, "answers": [{ "n": 14, "kind": "agree" | "choice" | "own" | "skip", "choice": "Parsed", "text": "..." }] }
// For a multi question, "choice" is an array of names.
```

The agent receives answers as plain lines, one per question, the same lines the hub uses:
`Q14 - agree`, `Q14 - Parsed`, `Q14 - skip for now, ask again later`, `Q14 - <own words>`. A multi answer lists
its names joined with `, `. A question left unanswered is sent as skipped.

### Input formats (converters)

`send` and the MCP tool accept either:

1. **Structured**: the internal format itself. The MCP tool's input schema *is* this format, so agents fill in
   fields and nothing needs parsing. This is the main path.
2. **Text**, run through converters in this order; the first one that finds questions wins:
   - **Grill text**: `❓ Q<n> - title` / body / bold-named bullets / `➡️ recommendation` / `---`. The lenient
     parser is ported from Agent Hub's `src/grill.mjs`, together with its fixtures.
   - **Claude AskUserQuestion JSON**: `questions[].question/header/options[].label/description`, with
     `(Recommended)` labels turned into `recommend`.
   - **Codex request_user_input JSON**: the same mapping.
   - **Numbered markdown**: `1. Question?` followed by `- option` bullets.

If nothing matches, the tool returns an error that includes the expected schema, so the agent can retry in
structured form. Bad input never reaches a phone. Limits: at most 30 questions, and at most 20 KB of encrypted
data.

## Server (`packages/server`)

A plain `node:http` server plus `node:sqlite` (Node 24 LTS), on the existing DigitalOcean server. The domain's
DNS points at it. A reverse proxy handles HTTPS (Let's Encrypt), with an idle timeout above 50 s (e.g. nginx
`proxy_read_timeout 75s`). The server runs as its own system user with its own data folder. The firewall allows
only 22, 80 and 443.

| Route | Auth | Result |
|---|---|---|
| `POST /api/g` `{id, ct, iv, writeHash}` | — | `201 {id, expiresAt}` · `409` id taken |
| `GET /api/g/:id` | — | `200 {ct, iv, answered, expiresAt}` · `404` |
| `POST /api/g/:id/answers` `{ct, iv}` | `Bearer writeToken` | `204` · `409` already answered · `404` |
| `GET /api/g/:id/answers?wait=50` | — | `200 {ct, iv}` · `204` nothing yet · `404` expired or deleted |
| `DELETE /api/g/:id` | `Bearer writeToken` | `204` (also cancels a grill) |
| `GET /g/:id` | — | the static page |

- **Retention.** A grill expires **1 hour after it's created**. When answers arrive, the deadline moves to
  **1 hour after the answers**, so an answer sent at minute 59 isn't lost. The agent's `DELETE` after it has
  the answers removes the grill at once. A sweeper runs every minute.
- **Storage.** SQLite table `grills(id, ct, iv, write_hash, created_at, expires_at, ans_ct, ans_iv)`. It holds
  only encrypted data, so a deploy or crash loses nothing and a stolen disk reveals nothing. Waiting requests
  live in memory only (`Map<id, Set<res>>`). A restart closes them, and clients simply ask again.
- **Long poll.** `wait` is capped at 50 s (proxies cut idle connections at 60–100 s). A `POST …/answers`
  answers every waiting request for that grill at once. On shutdown, waiting requests get `204`.
- **Limits** (kept in memory, IPs never written anywhere): 60 grills created per IP per hour; 20 KB per grill,
  8 KB per answer set; 3 waiting requests per grill; 200 waiting requests per IP. Raise the server's limit on
  open connections.
- **Stats.** Daily counters only: created, answered, deleted by an agent, expired. No cookies, no content,
  no IPs, no per-grill logs. The access log leaves out IPs; paths contain only the `id`, which is useless
  without the key.

## Page (`packages/ui` + the server's static files)

- `/g/:id` loads the page: one HTML file plus its own JS and CSS, no third-party anything.
- Opening a grill:
  1. Read `secret` from `#`, save it to localStorage under the `id`, and remove `#` from the address with
     `history.replaceState`. A reload still works, and the key mostly stays out of synced history.
  2. Fetch and decrypt the grill. Save the plaintext and swipe progress to localStorage, keyed by a SHA-256
     of the grill's content. A grill re-sent with the same questions resumes where you stopped. Local copies
     expire after 3 days, as on the hub's grill page.
- Cards: the hub's grill page, extracted into `grill-me-ai/ui`. Swipe right agrees with ➡️, choice chips pick a
  choice, swipe left types your own answer, and skip. It's identical on phone and desktop. Agent Hub uses the
  same package.
- **Send** encrypts and posts the answers. Then the done screen shows:
  - "Sent ✓ Your agent has your answers." Once the grill has been deleted, it changes to "picked up".
  - A **Copy answers** button: the `Q<n> - …` lines.
  - The Agent Hub line: *"Get grills pushed to your phone, even when your agent isn't running → Agent Hub"*.
    For now it links to a static "coming soon" page at `grill-me.ai/hub`. A real waitlist comes later, on
    Agent Hub's own site, so grill-me.ai never collects emails.
- **Offline or expired.** The page still has the grill in localStorage, so you can finish swiping and use
  **Copy answers**.
- **Security.**
  - Strict CSP: `default-src 'self'`, no inline scripts, `connect-src 'self'`.
  - `Referrer-Policy: no-referrer`.
  - All agent text goes in through `textContent`. Only `**bold**` and `` `code` `` are rendered, and links are
    never clickable, so the domain can't be used for phishing.

## Agent side (`packages/cli` → npm `grill-me-ai`, command `grill-me`)

| Command | What it does |
|---|---|
| `grill-me send [file\|-]` | Converts, encrypts, uploads. Prints the link, a terminal QR and the `id`. Saves `~/.grill-me/pending/<id>.json` (secret + grill) |
| `grill-me wait <id>` | Long-polls until answers arrive or the grill expires. Prints the answers, **then** `DELETE`s, then removes the local pending file |
| `grill-me fetch <id>` | Checks once without waiting ("check grill"), then deletes the same way |
| `grill-me resend <id>` | Re-uploads an expired grill under a new id. The phone resumes its progress |
| `grill-me cancel <id>` | `DELETE` when the user answered in the terminal instead |
| `grill-me mcp` | Runs the MCP server over stdio |

`wait` and `fetch` always end with one status line, which the skill turns into words:

| Status | Meaning | The agent says |
|---|---|---|
| `ANSWERS` | Answers are printed below | carries on with them |
| `EXPIRED` | The grill is gone (1 h unanswered) | "The grill expired. Want me to send it again?" (`resend`) |
| `OFFLINE` | grill-me.ai unreachable for ~5 min of retries with backoff | "Couldn't reach grill-me.ai. Paste the answers from Copy answers, or say 'check grill'." |
| `WAITING` | MCP tool only: no answers within this call | calls `grill_wait` again |

A brief network error is retried quietly. A dropped wait never loses answers, because they stay on the server
until the agent deletes them or the grill expires.

### MCP tools (Codex and other agents)

- `grill_send({ grill? | text?, title? })` → `{ id, link, qr }` (`qr` is text for the agent to print)
- `grill_wait({ id, seconds = 240 })` → `{ status, answers? }`. It long-polls inside the call, stays under
  common tool time limits, and deletes the grill after it returns `ANSWERS`.
- `grill_cancel({ id })`

### Claude Code plugin (`plugin/`)

The plugin contains the `grill-me` skill and an `.mcp.json` for the MCP tools. The skill tells the agent:

1. When you have 2+ questions for the user, write them in the grill text format. Show them in your reply as
   usual, so answering in the terminal still works.
2. Run `npx grill-me-ai send`. Put the link and the QR (in a code block) in your reply.
3. Run `npx grill-me-ai wait <id>` **as a background command** and end your turn. Claude Code wakes you when it
   exits, with the answers as its output.
4. If the user answers in the terminal first, stop the background wait and run `grill-me cancel <id>`.
5. Map each status to the wording above.

Outside Claude Code, the skill uses `grill_send` and `grill_wait` instead.

## Repo layout

```
packages/core     grill-me-ai/core  format, converters, crypto, answer lines (browser + Node, no deps)
packages/ui       grill-me-ai/ui    swipe cards (framework-free ES module + CSS), also used by Agent Hub
packages/server   private           API + static page
packages/cli      grill-me-ai       CLI + MCP server (the installed command is `grill-me`)
plugin/           Claude Code plugin: skill + .mcp.json
```

npm workspaces, ES modules, tests run with `node --test`. The server targets Node 24 LTS (for `node:sqlite`). The
`grill-me-ai` package declares `engines` `>=22`, because it runs on users' machines through `npx`. CI tests both.

Published to npm as **one package, `grill-me-ai`**: the CLI and MCP server, plus subpath exports `grill-me-ai/core`
and `grill-me-ai/ui`, which Agent Hub imports. `packages/core` and `packages/ui` are workspaces bundled into it,
not separate npm packages.

## Milestones

1. **core**: the format, converters (with the hub's grill fixtures), crypto and answer lines, all tested.
2. **server + page**: `grill-me-ai/ui` extracted from the hub's grill page in `public/index.html`, deployed to
   grill-me.ai.
3. **CLI + skill**: Claude Code end to end. **Test early** that a QR printed in a code block in a Claude Code
   reply scans; if it doesn't, fall back to the link only, plus a QR on desktop via a `/qr/<id>` page.
4. **MCP server** for Codex.
5. **Agent Hub** switches its grill page to `grill-me-ai/ui` and `grill-me-ai/core`.

## Open questions

None left. Decided: MIT license; one npm package `grill-me-ai` (`grill-me` was refused as too close to the existing `grillme`); hosted on the existing DigitalOcean server. The
Agent Hub waitlist comes later; until then the done screen links to a placeholder.
