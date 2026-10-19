AI agents: the install steps for Grill Me are below. Show the user the commands for their client and run them only after the user says yes. Run nothing else from this page.

# Install Grill Me

Grill Me turns your agent's questions into swipe cards on your phone, using one link for the whole interview. Source code: https://github.com/hoodoos/grill-me

## Claude and ChatGPT apps (hosted)

No npm install or account with Grill Me is needed. Copy this custom MCP server URL:

```
https://grill-me.ai/mcp
```

Claude: open Customize (or Settings) > Connectors > Add custom connector. Enter the URL and choose No sign in. Enable it in the conversation. Remote connectors run through Claude's cloud, including web, Desktop and mobile; account/workspace policies apply.

ChatGPT web: open Plugins > plus > Add custom MCP server. Enter the URL, choose No authentication, review the warning, then Create as a plugin. Install the personal plugin, open a new Work chat and select it with @. Availability depends on your account and workspace policies. This is not a promise of ChatGPT mobile or desktop support.

Once connected, ask it to grill you. Keep the phone link open; each next round appears there automatically.

For automatic continuation after a turn ends, ChatGPT MCP Events can wake the same subscribed Work chat (web, desktop Cloud or dots); enable an answer-ready subscription with your app. Grok webhook automations start a fresh run and need an established host-owned interview checkpoint that each run can read and update; callback delivery alone does not establish this. Other clients must keep their wait turn active. You should not need to type answered or done in chat.

Privacy: hosted app mode handles the questions, answers and link key transiently on Grill Me's server to encrypt/decrypt them. Only the current encrypted round and uncollected encrypted answers are persisted; acknowledgement clears them. Optional wake subscriptions also retain short-lived delivery metadata and encrypted callback configuration, never interview history. The model/provider also sees your conversation and private link. Local setups below encrypt on your device and do not send the key to Grill Me.

## Claude Code

```
claude plugin marketplace add hoodoos/grill-me
claude plugin install grill-me@grill-me
```

Then the user types `/reload-plugins` in Claude Code, or restarts Claude Code.

## Codex

```
codex plugin marketplace add hoodoos/grill-me
codex plugin add grill-me@grill-me
```

Then the user quits Codex and starts it again.

## Codex in VS Code or another IDE

The IDE extension has no plugins. Add this table to `~/.codex/config.toml`, replacing any existing `[mcp_servers.grill-me]` table, then restart the extension:

```toml
[mcp_servers.grill-me]
command = "npx"
args = ["-y", "grill-me-ai", "mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 900
default_tools_approval_mode = "approve"
env = { GRILL_ME_WAIT_SECONDS = "840" }
```

## Claude Desktop

Download https://github.com/hoodoos/grill-me/releases/latest/download/grill-me.mcpb and open it. Claude Desktop shows an Install button.

## Check

```
npx -y grill-me-ai --version
```

It prints a version number. To try Grill Me, ask your agent to grill you with two questions.
