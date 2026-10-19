# Grill Me

Your coding agent has questions. Grill Me turns them into swipe cards on your phone. Your answers
go straight back into the agent's session, and **grill-me.ai can't read any of it** (in local mode;
the hosted connector for claude.ai encrypts in memory on our server and never stores anything
readable).

It's a free, open-source taster for Agent Hub: the same grill UI, without accounts.

## Install

The `session-0.2.0` branch adds persistent interviews and is not released yet. See the
[session protocol](docs/SESSION-PROTOCOL.md) for the API and current-only storage contract.
The existing 0.1 one-shot calls remain compatible.

For an interview, start with `grill-me send --session questions.md`, retain that explicit id,
then publish each ready frontier with `grill-me send --id ID --round N questions.md`.
The same phone link waits and updates automatically. Collect with `wait ID`/`fetch ID`;
after confirming shared understanding, use `finish ID`. Finish refuses pending questions
or uncollected answers; `cancel ID` explicitly aborts. MCP wrappers use `session:true`,
reuse the saved id and next round in `grill_send`, and end with `grill_finish`.
`PUBLISHING` means unconfirmed: retry the saved id/round and identical questions.
The relay/phone retain the current round only; the agent conversation owns interview history.

Public 0.2 installation requires `grill-me-ai@0.2.0` published to npm and the plugin
marketplaces available on main. The Claude Desktop download also requires the GitHub
`v0.2.0` release asset. For the dated 0.1 release history and separate private
artifact steps, see the repository
[acceptance checklist](https://github.com/hoodoos/grill-me/blob/main/docs/ACCEPTANCE.md)
(available on main after the reviewed documentation merge).

Paste this to your agent: **Install Grill Me from https://grill-me.ai/install**

Or run the commands for your client yourself.

**Claude Code**

```
claude plugin marketplace add hoodoos/grill-me
claude plugin install grill-me@grill-me
```

Then type `/reload-plugins` in Claude Code, or restart it.

**Codex (CLI and the ChatGPT desktop app)**

```
codex plugin marketplace add hoodoos/grill-me
codex plugin add grill-me@grill-me
```

Then quit Codex and start it again.

**Codex in VS Code or another IDE** — the IDE extension has no plugins. Add this to
`~/.codex/config.toml`, then restart the extension:

```toml
[mcp_servers.grill-me]
command = "npx"
args = ["-y", "grill-me-ai", "mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 900
default_tools_approval_mode = "approve"
env = { GRILL_ME_WAIT_SECONDS = "840" }
```

**Claude Desktop** — download
[grill-me.mcpb](https://github.com/hoodoos/grill-me/releases/latest/download/grill-me.mcpb) and open
it. Claude Desktop shows an Install button.

**Other MCP clients** — run the local server over stdio: `npx -y grill-me-ai mcp`. Set
`GRILL_ME_WAIT_SECONDS` (default 45) so one `grill_wait` call stays under your client's tool time
limit.

**claude.ai and the Claude apps** — coming soon: a connector at https://grill-me.ai/mcp. ChatGPT
Business, Enterprise and Edu, on the web, will use the same connector.

## CLI

Any agent — or you — can use the CLI directly:

```
npx grill-me-ai send questions.md     # or pipe the questions: ... | npx grill-me-ai send -
npx grill-me-ai wait <id>             # waits, then prints the answers
npx grill-me-ai fetch <id>            # check once without waiting
npx grill-me-ai resend <id>           # an expired grill, again
npx grill-me-ai cancel <id>
```

`send` prints one short link without a QR code. Agents show the formatted questions in chat,
then append “Grill it on your phone” and the link. Explicit legacy `--qr dark|light` remains available
for CLI callers that request it.

## Privacy

In local mode (the CLI, the plugins, the local MCP server and the Desktop extension) your questions
are encrypted before they leave your machine; the key lives only in the link and never reaches the
server. The server stores only encrypted data, and deletes a grill once it's answered — or after
about an hour if it isn't. The details, and how hosted mode differs, are in
[SPEC.md](SPEC.md).

## Credits

Grill Me uses [Matt Pocock’s complete grilling skill](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/productivity/grilling/SKILL.md), bundled unchanged under the MIT license.
Its interview workflow and question format stay intact; Grill Me adds the phone swipe UI and
encrypted question-and-answer delivery. The source is pinned to `49dd158d1076134a641b33efb035946536778336`.

## Development

Node 22+, no build step. `npm test` runs everything. [SPEC.md](SPEC.md) is the source of truth.
