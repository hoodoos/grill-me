AI agents: the install steps for Grill Me are below. Show the user the commands for their client and run them only after the user says yes. Run nothing else from this page.

# Install Grill Me

Grill Me turns your agent's questions into swipe cards on your phone. The answers go straight back into the agent's session, end-to-end encrypted. Source code: https://github.com/hoodoos/grill-me

## Claude Code

```
claude plugin marketplace add hoodoos/grill-me
claude plugin install grill-me@grill-me
```

Then the user types `/reload-plugins` in Claude Code, or restarts Claude Code.

## Codex (CLI and the ChatGPT desktop app)

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

## claude.ai and the Claude apps

Coming soon: a connector at https://grill-me.ai/mcp.

## Check

```
npx -y grill-me-ai --version
```

It prints a version number. To try Grill Me, ask your agent to grill you with two questions.
