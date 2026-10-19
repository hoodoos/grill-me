# Grill Me — spec

Your coding agent has questions. Grill Me turns them into swipe cards on your phone. Your answers go straight back
into the agent's session, and **grill-me.ai can't read any of it** (in local mode; app mode for claude.ai and
ChatGPT encrypts on our server in memory and never stores anything readable).

It's a free, open-source taster for Agent Hub: the same grill UI, without accounts.

## Goals

The additive 0.2.0 persistent-interview extension is specified in
[docs/SESSION-PROTOCOL.md](docs/SESSION-PROTOCOL.md). It reuses one session link across frontier
rounds, retains current state only, and preserves the 0.1.0 one-shot paths described below.

- An agent with 2+ questions shows **the formatted questions, followed by “Grill it on your phone” and one
  short link**. You open it on any device and answer by swiping. The answers arrive in the agent's session within a second.
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
  prints questions + link                                                  opens link
grill-me wait ── long poll ─────────▶  holds the request (≤ 50 s)  ◀── GET  decrypts, swipes
                                                                            (progress in localStorage)
              ◀── encrypted answers ── answers the open request    ◀── POST encrypted answers
prints answers into the session
DELETE ─────────────────────────────▶  deletes grill + answers
```

## Link and keys

- Link: `https://grill-me.ai/g/<id>#<secret>`
  - `id`: 12 random bytes, base64url (16 chars). The agent picks it, because the blob's AAD needs the `id` before
    upload. Core never generates an id that starts with `-`, so ids don't look like command-line options. The
    server still accepts any valid id. The server rejects any `id` that isn't exactly 16 base64url characters and answers `409` if it's
    taken; the agent then picks a new one.
  - `secret`: 16 random bytes, base64url (22 chars). The agent creates it. It sits after `#`, so browsers
    never send it to the server.
  - The whole link is about 60 characters. Normal agent replies show it as a clickable link.
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
   - **Grill text**: Matt’s `❓ **Q<n>** - **title**: body` / choices / `➡️ recommendation` / `---`
     (also accepts the existing `❓ Q<n> - title` line with body below). The lenient
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
| `grill-me send [file\|-]` | Converts, encrypts, uploads. Prints the link and the `id`, without a QR by default. Saves `~/.grill-me/pending/<id>.json` (secret + grill). Explicit legacy `--qr dark|light`, `--qr off`, `--json` |
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
Locally, encrypted answers are cached atomically in the pending record before delivery and replayed until output succeeds and DELETE is confirmed, so cancellation or a lost DELETE reply cannot lose answers.

Normal CLI sends and agent replies do not generate or print QR codes. The explicit legacy CLI QR option
uses Unicode half blocks, ECC level M, and a 2-module quiet zone; `--qr light` is for light terminals.

### Grilling workflow

Use Matt Pocock’s complete `grilling` skill, including its exact question format, design-tree
frontier rounds, fact-finding, recommendations and confirmation of shared understanding before acting.
The source is pinned to `mattpocock/skills@49dd158d1076134a641b33efb035946536778336` and bundled
unchanged: `references/grilling.md` in both plugin skills and `packages/core/src/grilling.md` for
MCP-only clients. The local MCP server supplies the full upstream body in its initialize instructions.
Grill Me adds phone delivery after each visible round; it does not replace the interview workflow.

### MCP tools (local server, `grill-me mcp`)

- `grill_send({ grill? | text?, title? })` → `{ id, link, count, expiresAt }` (no QR payload)
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
- **Codex:** a Codex plugin (`codex-plugin/`, listed in `.agents/plugins/marketplace.json`). It bundles a Codex
  version of the skill, which uses the MCP tools, and the MCP server with a raised tool timeout, so one call can
  wait long. The IDE extension has no plugins, so there the user adds the same server to `~/.codex/config.toml`:
  ```toml
  [mcp_servers.grill-me]
  command = "npx"
  args = ["-y", "grill-me-ai", "mcp"]
  startup_timeout_sec = 60
  tool_timeout_sec = 900
  default_tools_approval_mode = "approve"
  env = { GRILL_ME_WAIT_SECONDS = "840" }
  ```

### Claude Code plugin (`plugin/`)

The plugin contains the `grill-me` skill. In Claude Code the skill uses the CLI, not MCP, because background
commands let a wait last as long as it needs. So the plugin ships no MCP server. A plugin's `.mcp.json` can't
vary by OS (native Windows needs `cmd /c npx`), and it would start `npx` in every session. The skill tells the
agent:

1. When you have 2+ questions for the user, write them in the grill text format. Show them in your reply as
   usual, so answering in the terminal still works.
2. Run `npx grill-me-ai send`. Show the formatted questions, then end your reply with “Grill it on your phone” and the link as plain text.
3. Run `npx grill-me-ai wait <id>` **as a background command** and end your turn. Claude Code wakes you when it
   exits, with the answers as its output.
4. If the user answers in the terminal first, stop the background wait and run `grill-me cancel <id>`.
5. Map each status to the wording above.

## Hosted mode (`grill-me.ai/mcp`)

M4b uses stateless authless Streamable HTTP, preserving the shipped0.2 same-link,
current-round-only interview protocol. The precise tool/schema, retry, privacy, quota and
transport contract is [docs/HOSTED-MCP.md](docs/HOSTED-MCP.md).

- Six server-only tools: `grill_start` prepares a private capability without publishing;
  `grill_send` publishes each explicit round using that same link and exact expected revision;
  `grill_wait` returns answers without clearing them; `grill_ack` confirms actual model receipt
  with the unchanged original round/revision/submission receipt; `grill_finish` requires idle;
  `grill_cancel` explicitly aborts. Network response completion is never treated as model receipt.
- Randomized AES-GCM/v2 session+round+slot AAD stays unchanged. Keyed canonical-input publish
  identities allow exact lost-reply/concurrent retry without replacing pending content.
  The private key/plaintext exists transiently in a call; no readable persistence, local
  pending files or argument/result/error logging. Only current ciphertext/opaque relay
  retry identity and existing minimal10minute terminal receipts persist; no interview history.
- POST `/mcp` validates Origin, JSON-RPC/Accept/content/body and uses sanitized errors.
  GET/DELETE405, no Mcp-Session-Id. Waits open SSE immediately with keepalives, default45s
  and max50s across both clients. Response closure aborts/reclaims capacity.
- Hosted quotas are independent of shared platform IPs:600new sessions/hour,200concurrent
  waits,30new sessions/hour/conversation where bounded client metadata identifies one.
  Conversation digests/counters are bounded and memory-only; private stats show headroom
  and aggregate rejection counts. Existing shared per-session waiter caps still apply.
- Exact nginx `/mcp` proxy requires request and response buffering OFF, HTTP1.1,32KB body
  buffer and `client_body_in_file_only off` to avoid plaintext request spooling. Access/error
  logging is disabled only here; no query capabilities. This is an intentional site-local
  nginx configuration/deploy-tree change, not a neighbour configuration change.
- Local mode encrypts on the user's device and never sends the key. App mode handles the
  key and readable questions/answers transiently on our server; the model/provider also sees
  the conversation/private link. Only encrypted content is persisted. State this distinction.
- Current official documentation (checked2026-10-19): Claude remote custom connectors run
  through Claude's cloud across web/Desktop/mobile. ChatGPT custom MCP setup is documented
  for web via Plugins > Add custom MCP server > No authentication; account/workspace policies
  apply. The old Business-only/web-only certainty is retired: do not infer current plan
  access or mobile/desktop support. Actual account/client behavior needs actual observation.
  See the primary-source links in the hosted protocol document.
- Complete pinned Matt workflow is included unchanged in initialize instructions; the first
  512characters explain the hosted capability/send/wait/explicit-ACK cycle independently.
  No npm publication is needed for hosted custom connections. Public-directory submission
  and in-chat MCP Apps cards remain separate future work.

## Install

The user tells their agent "Install Grill Me from https://grill-me.ai/install" (or just "…from
https://grill-me.ai"), and the agent does the rest.

- **One source:** `site/install.md` in the repo, so anyone can see exactly what it tells agents. It changes only
  through a PR. It's short and boring on purpose:
  - Its first line tells AI agents to show the user the commands and run them only after a yes, and to run nothing
    else from the page.
  - It holds only the install commands per client: no other actions, no `curl | sh`.
- **Per client:**
  - Claude Code: `claude plugin marketplace add hoodoos/grill-me`, then `claude plugin install grill-me@grill-me`;
    then the user types `/reload-plugins` or restarts.
  - Codex CLI and the ChatGPT desktop app: `codex plugin marketplace add hoodoos/grill-me`, then
    `codex plugin add grill-me@grill-me`; then the user restarts Codex.
  - Codex in an IDE (no plugins there): the `config.toml` table from [Desktop apps](#desktop-apps).
  - Claude Desktop: the `.mcpb` from the latest GitHub release.
  - claude.ai and the Claude apps: the hosted connector URL, once milestone 4b ships.
  - A final check: `npx -y grill-me-ai --version`.
- **Served three ways, all built from that one file:**
  - `GET /install`: the file as `text/plain`, with a CSP of `default-src 'none'` and no scripts.
  - `GET /` with content negotiation: when `Accept` mentions `text/markdown`, or doesn't mention `text/html`, or
    the `User-Agent` is curl or Wget, the guide itself; otherwise the homepage. Both carry
    `Vary: Accept, User-Agent`. nginx applies the same rule with a `map`.
  - The homepage carries the guide in its static HTML near the top: "Paste this to your agent: Install Grill Me
    from https://grill-me.ai/install", then the same commands in code blocks, so an agent that summarizes the HTML
    still gets them verbatim. It also has `<link rel="alternate" type="text/markdown" href="/install">`, and
    `/llms.txt` points to `/install`.
- **Tested the way agents fetch:** curl, a real Codex fetch, and Claude Code's WebFetch, which needs a public
  HTTPS host, so it runs against grill-me.ai.

## Repo layout

```
packages/core     grill-me-ai/core  format, converters, crypto, answer lines (browser + Node, no deps)
packages/ui       grill-me-ai/ui    swipe cards (framework-free ES module + CSS), also used by Agent Hub
packages/server   private           API + static page + stats + hosted MCP (/mcp)
packages/cli      grill-me-ai       CLI + local MCP server (the installed command is `grill-me`)
plugin/           Claude Code plugin: the skill (listed in .claude-plugin/marketplace.json)
codex-plugin/     Codex plugin: a skill + the MCP server (listed in .agents/plugins/marketplace.json)
site/             install.md (the agent install guide) and llms.txt
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
   `/stats`, `/healthz` and the agent install guide (`/install`, the homepage, `/llms.txt`), with deploy files for
   grill-me.ai.
3. **CLI + skill**: Claude Code end to end. The early test passed: a QR printed in a code block in a Claude Code
   reply scans on a phone, in both the dark and the light version.
4. **Local MCP server** for Codex and other agents, the Codex plugin, the Claude Desktop extension (`.mcpb`) and
   the Codex config for IDEs.
4b. **Hosted MCP server** at `grill-me.ai/mcp` for claude.ai (web and mobile) and ChatGPT.
5. **Agent Hub** switches its grill page to `grill-me-ai/ui` and `grill-me-ai/core`.

Later: in-chat swipe cards through the MCP Apps extension.

## Open questions

None left. Decided: MIT license; one npm package `grill-me-ai` (`grill-me` was refused as too close to the existing `grillme`); hosted on the existing DigitalOcean server. The
Agent Hub waitlist comes later; until then the done screen links to a placeholder. Updated 2026-10-19: formatted questions plus a phone link are the default; QR is an explicit legacy CLI option.
Metrics are the daily funnel above, on a private `/stats` page; hosted mode keeps the key with the model; desktop users get local mode through the `.mcpb` extension and the Codex snippet.
