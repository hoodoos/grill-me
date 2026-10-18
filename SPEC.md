# Grill Me — spec

Your coding agent has questions. Grill Me turns them into swipe cards on your phone. Your answers go straight back
into the agent's session, and **grill-me.ai can't read any of it** (in local mode; app mode for claude.ai and
ChatGPT encrypts on our server in memory and never stores anything readable).

It's a free, open-source taster for Agent Hub: the same grill UI, without accounts.

## Goals

- An agent with 2+ questions prints **one short link and the same link as a QR code**. You open it on any device
  and answer by swiping. The answers arrive in the agent's session within a second.
- **End-to-end encrypted.** The server stores only encrypted data, and in local mode (CLI, plugin, local MCP
  server, Desktop extension) the key never reaches it. App mode (the hosted MCP server for claude.ai and
  ChatGPT, see [Hosted mode](#hosted-mode-grill-meaimcp)) encrypts on the server in memory and still never stores
  anything readable.
- **Kept only as long as needed.** A grill is deleted once the agent has its answers, and an unanswered grill
  after about an hour.
- **No accounts and no setup.** `npx grill-me-ai`, a Claude Code plugin, a Claude Desktop extension, a local MCP
  server, or the hosted one at `https://grill-me.ai/mcp`.
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
`proxy_read_timeout 75s`). The server runs as its own system user with its own data folder, listens on
`127.0.0.1` only, and adds no firewall rules. nginx proxies `/api/`, `/g/`, `/go/`, `/stats`, `/healthz` and
`/mcp` to it and serves everything else from a static folder. The box also runs a game server, so the service
is capped (systemd `MemoryMax=256M`, `CPUQuota=25%`, low CPU and IO priority).

| Route | Auth | Result |
|---|---|---|
| `POST /api/g` `{id, ct, iv, writeHash, qb?}` | — | `201 {id, expiresAt}` · `409` id taken |
| `GET /api/g/:id` | — | `200 {ct, iv, answered, expiresAt}` · `404` |
| `POST /api/g/:id/answers` `{ct, iv}` | `Bearer writeToken` | `204` · `409` already answered · `404` |
| `GET /api/g/:id/answers?wait=50` | — | `200 {ct, iv}` · `204` nothing yet · `404` expired or deleted |
| `DELETE /api/g/:id` | `Bearer writeToken` | `204` (also cancels a grill) |
| `GET /g/:id` | — | the static page |
| `GET /go/hub` | — | `302` to `/hub`, counted as a click |
| `GET /stats`, `/stats/data.json`, `POST /stats/login` | stats token | the private stats page (see [Metrics](#metrics)) |
| `GET /healthz` | — | `200 {"ok":true}` · `503`, for an outside uptime monitor |
| `POST /mcp` | — | the hosted MCP server (see [Hosted mode](#hosted-mode-grill-meaimcp)) |

`expiresAt` is epoch milliseconds. Every API route can also answer `400` for malformed input, `413` for a body
over 32 KB and `429` when a limit is hit. Routes that need the write token answer `401` when it's missing or
malformed and `403` when it's wrong.

- **Retention.** A grill expires **1 hour after it's created**. When answers arrive, the deadline moves to
  **1 hour after the answers**, so an answer sent at minute 59 isn't lost. The agent's `DELETE` after it has
  the answers removes the grill at once. A sweeper runs every minute.
- **Storage.** SQLite table `grills(id, ct, iv, write_hash, created_at, expires_at, opened_at, ans_ct, ans_iv)`.
  It holds only encrypted data, so a deploy or crash loses nothing and a stolen disk reveals nothing. Waiting requests
  live in memory only (`Map<id, Set<res>>`). A restart closes them, and clients simply ask again.
- **Long poll.** `wait` is capped at 50 s (proxies cut idle connections at 60–100 s). A `POST …/answers`
  answers every waiting request for that grill at once. On shutdown, waiting requests get `204`.
- **Limits** (kept in memory, IPs never written anywhere): 60 grills created per IP per hour; 20 KB per grill,
  8 KB per answer set; 3 waiting requests per grill; 200 waiting requests per IP. Raise the server's limit on
  open connections.
- **Logs.** The access log leaves out IPs, user agents and query strings; paths contain only the `id`, which is
  useless without the key. Nothing logs request bodies, tool arguments or tool results, error paths included.

### Metrics

The funnel, as **daily totals only** (UTC days, kept 400 days). Never content, IPs, ids, link parts or
per-grill rows.

- **Counts:** created → opened (the first `GET /api/g/:id` of a grill) → answered → picked up (an agent's
  `DELETE` after answers). Also cancelled (`DELETE` without answers), expired unanswered, expired answered but
  never picked up, and clicks on the done screen's Agent Hub link (`/go/hub`).
- **Bucket counters** (one counter per bucket per day, from which the stats page estimates medians and p90s):
  time to open and time to answer (`<1m`, `1-5m`, `5-15m`, `15-30m`, `30-60m`, `>60m`), grill size in
  ciphertext bytes, and question count (`1`, `2-3`, `4-6`, `7-10`, `11-20`, `21-30`).
- **Agent and version:** from the CLI's `User-Agent: grill-me-ai/<version> (<agent>)`. The agent comes from env
  `GRILL_ME_AGENT`, or `claude-code` when `CLAUDECODE=1`; nothing else is detected and nothing is fingerprinted.
  In MCP modes the agent is the MCP `clientInfo.name`. The server keeps only names on a fixed allowlist (others
  count as `unknown`) and at most 20 versions a day.
- **Question count:** in local mode the server can't see it, because it's inside the encrypted grill. So the
  client sends only its bucket (`qb`) when creating the grill. It's counted and never stored with the grill.

**`/stats`** is private. It's behind a long `STATS_TOKEN` from the server's env file, sent as
`Authorization: Bearer …` or as a cookie set once through a login box. The cookie holds an HMAC of the token, and
the token never goes in a URL. The page shows the funnel per day for the last 30 days, the distributions, agents
and versions, plus live health: open waiting requests, requests and errors per minute, memory against the
256 MB cap, uptime, version and DB size. **`/healthz`** says only whether the server and its DB are up.

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
    For now it links through `/go/hub` (a redirect that only counts the click) to a static "coming soon" page at
    `grill-me.ai/hub`. A real waitlist comes later, on
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
| `grill-me send [file\|-]` | Converts, encrypts, uploads. Prints the link, a terminal QR and the `id`. Saves `~/.grill-me/pending/<id>.json` (secret + grill). `--qr light` for light terminals, `--qr off`, `--json` |
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

The terminal QR uses Unicode half blocks, ECC level M, and a 2-module quiet zone. By default it is drawn for a
dark terminal: the light modules are the blocks. That default was tested by scanning a Claude Code reply with a
phone, and `--qr light` flips it for light terminals.

### MCP tools (local server, `grill-me mcp`)

- `grill_send({ grill? | text?, title? })` → `{ id, link, qr }` (`qr` is text for the agent to print)
- `grill_wait({ id, seconds? })` → `{ status, answers? }`. It long-polls inside the call and deletes the grill
  after it returns `ANSWERS`. It must return before the client's tool time limit, which is 60 s by default in
  Codex and ChatGPT and 240 s in claude.ai and Claude Desktop. So `seconds` defaults to env
  `GRILL_ME_WAIT_SECONDS`, else 45, and is capped at 900. Without answers it returns `WAITING`, and the agent
  calls it again.
- `grill_cancel({ id })`

The local server keeps the secret in `~/.grill-me/pending/`, like the CLI, so this is local mode: grill-me.ai
never sees a key.

### Desktop apps

- **Claude Desktop:** a one-click extension, `grill-me.mcpb` (manifest 0.3, `server.type` `node`, since Claude
  Desktop ships its own Node). It wraps the local MCP server with `GRILL_ME_WAIT_SECONDS=180`, so a call stays
  under Desktop's 240 s limit. Built with the official `mcpb` CLI and attached to each GitHub release.
- **Codex:** the README gives the config snippet. It raises Codex's 60 s tool timeout so that one call can wait
  long:
  ```toml
  [mcp_servers.grill-me]
  command = "npx"
  args = ["-y", "grill-me-ai", "mcp"]
  startup_timeout_sec = 30
  tool_timeout_sec = 900
  env = { GRILL_ME_WAIT_SECONDS = "840" }
  ```

## Hosted mode (`grill-me.ai/mcp`)

claude.ai on the web, the Claude mobile apps and ChatGPT can only use remote MCP servers. So the same Node
server also serves a remote MCP endpoint at `https://grill-me.ai/mcp`, with the same tools.

- **Transport:** streamable HTTP, stateless. `POST /mcp` takes JSON-RPC. `Mcp-Session-Id` is neither required
  nor issued. `GET /mcp` returns `405`. A `tools/call` that waits answers with an SSE stream opened at once,
  with keep-alive comments, so proxies and clients don't cut an idle response.
  - An `Origin` header, if present, must be on a short allowlist (`https://claude.ai`, `https://chatgpt.com`,
    `https://grill-me.ai`); otherwise the server answers `403`. `/stats` counts rejected origins per day (scheme
    and host only, at most 20 distinct a day), so a real client that gets blocked is noticed.
- **No auth (authless).** Both claude.ai and ChatGPT allow that for custom connectors.
- **Key with the model:**
  - `grill_send`: the server makes the id and secret, encrypts in memory, and stores only the ciphertext and
    `writeHash`, exactly as in local mode. It returns `{ id, link, qr }`. Then it forgets the secret: it isn't
    written to disk or logs, and no reference is kept after the call.
  - `grill_wait({ link } | { id, secret }, seconds?)`: the model passes the link back. The server derives the
    keys, long-polls inside the call, decrypts the answers in memory and returns the answer lines. Then it
    `DELETE`s the grill and forgets the key.
  - The disk only ever holds encrypted data, never a key. Readable text exists only in memory during a call.
  - `grill_cancel({ link } | { id, secret })`.
- **Time limits:** ChatGPT cuts a tool call at about 60 s, and claude.ai at 240 s. So hosted `grill_wait`
  defaults to 45 s (or 180 s when `clientInfo.name` is a Claude client), is capped at 200 s, and returns
  `WAITING` for the model to call again.
- **No logging of tool arguments or results anywhere**, error paths included. Errors returned to the model never
  echo its input.
- **Limits:** calls arrive from the platforms' shared IPs, so per-IP limits don't fit here. Hosted mode has its
  own global caps: 600 grills an hour and 200 concurrent waits. Where the client sends a conversation id (ChatGPT's
  `_meta["openai/session"]`), there is also a cap of 30 grills an hour per conversation, kept in memory only, so
  one noisy conversation can't use up everyone's quota. Clients without one fall under the global caps only.
  `/stats` shows the global headroom and how often each cap is hit. Grills and their retention work exactly as in
  local mode.
- **Site wording:** "Local mode: we can't read your grills. App mode: your grill passes through our server only to
  be encrypted, and is never stored readable."
- **Where it works** (October 2026):
  - claude.ai: every plan (Free allows one custom connector), and its connectors also work in the Claude mobile
    apps.
  - ChatGPT: custom MCP servers are web only, and only Business, Enterprise and Edu allow write tools like
    `grill_send`.
  - The README and the site lead with claude.ai, the Claude apps, Claude Code and Codex. ChatGPT is listed as
    "ChatGPT Business, Enterprise and Edu, on the web". It never claims ChatGPT mobile, Plus or Free.
- **Later, not now:** in-chat swipe cards through the MCP Apps extension, with a `ui://` resource referenced from
  the tool's `_meta`. Tool results already carry `structuredContent`, so that can be added without changing the
  tools.

### Claude Code plugin (`plugin/`)

The plugin contains the `grill-me` skill and an `.mcp.json` for the MCP tools. The skill tells the agent:

1. When you have 2+ questions for the user, write them in the grill text format. Show them in your reply as
   usual, so answering in the terminal still works.
2. Run `npx grill-me-ai send`. Put the link in your reply as plain text, and the QR in a code block.
3. Run `npx grill-me-ai wait <id>` **as a background command** and end your turn. Claude Code wakes you when it
   exits, with the answers as its output.
4. If the user answers in the terminal first, stop the background wait and run `grill-me cancel <id>`.
5. Map each status to the wording above.

Outside Claude Code, the skill uses `grill_send` and `grill_wait` instead.

## Repo layout

```
packages/core     grill-me-ai/core  format, converters, crypto, answer lines (browser + Node, no deps)
packages/ui       grill-me-ai/ui    swipe cards (framework-free ES module + CSS), also used by Agent Hub
packages/server   private           API + static page + stats + hosted MCP (/mcp)
packages/cli      grill-me-ai       CLI + local MCP server (the installed command is `grill-me`)
plugin/           Claude Code plugin: skill + .mcp.json
mcpb/             the Claude Desktop extension (manifest + build script)
deploy/           nginx snippet, systemd unit, deploy/rollback/check scripts
```

npm workspaces, ES modules, tests run with `node --test`. The server targets Node 24 LTS (for `node:sqlite`). The
`grill-me-ai` package declares `engines` `>=22`, because it runs on users' machines through `npx`. CI tests both.

Published to npm as **one package, `grill-me-ai`**: the CLI and MCP server, plus subpath exports `grill-me-ai/core`
and `grill-me-ai/ui`, which Agent Hub imports. `packages/core` and `packages/ui` are workspaces bundled into it,
not separate npm packages.

## Milestones

1. **core**: the format, converters (with the hub's grill fixtures), crypto and answer lines, all tested.
2. **server + page**: `grill-me-ai/ui` extracted from the hub's grill page in `public/index.html`, plus metrics,
   `/stats` and `/healthz`, with deploy files for grill-me.ai.
3. **CLI + skill**: Claude Code end to end. The early test passed: a QR printed in a code block in a Claude Code
   reply scans on a phone, in both the dark and the light version.
4. **Local MCP server** for Codex and other agents, the Claude Desktop extension (`.mcpb`) and the Codex config
   snippet.
4b. **Hosted MCP server** at `grill-me.ai/mcp` for claude.ai (web and mobile) and ChatGPT.
5. **Agent Hub** switches its grill page to `grill-me-ai/ui` and `grill-me-ai/core`.

Later: in-chat swipe cards through the MCP Apps extension.

## Open questions

None left. Decided: MIT license; one npm package `grill-me-ai` (`grill-me` was refused as too close to the existing `grillme`); hosted on the existing DigitalOcean server. The
Agent Hub waitlist comes later; until then the done screen links to a placeholder. Decided 2026-10-18: the dark
QR is the default; metrics are the daily funnel above, on a private `/stats` page; hosted mode keeps the key with
the model; desktop users get local mode through the `.mcpb` extension and the Codex snippet.
