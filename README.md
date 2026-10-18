# Grill Me

Your coding agent has questions. Grill Me turns them into swipe cards on your phone. Your answers
go straight back into the agent's session, and **grill-me.ai can't read any of it** (in local mode;
the hosted connector for claude.ai encrypts in memory on our server and never stores anything
readable).

It's a free, open-source taster for Agent Hub: the same grill UI, without accounts.

## Install

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

`send` prints one short link and a terminal QR code (`--qr light` for light terminals, `--qr off`).

## Privacy

In local mode (the CLI, the plugins, the local MCP server and the Desktop extension) your questions
are encrypted before they leave your machine; the key lives only in the link and never reaches the
server. The server stores only encrypted data, and deletes a grill once it's answered — or after
about an hour if it isn't. The details, and how hosted mode differs, are in
[SPEC.md](SPEC.md).

## Development

Node 22+, no build step. `npm test` runs everything. [SPEC.md](SPEC.md) is the source of truth.
