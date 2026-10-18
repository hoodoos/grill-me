// Where the server and the local state live. Tests always pass explicit values or set the env vars.
import os from "node:os";
import path from "node:path";

export const DEFAULT_SERVER = "https://grill-me.ai";

export function resolveServer(explicit) {
  const server = explicit || process.env.GRILL_ME_SERVER || DEFAULT_SERVER;
  return server.replace(/\/+$/, "");
}

export function stateHome(explicit) {
  return explicit || process.env.GRILL_ME_HOME || path.join(os.homedir(), ".grill-me");
}

// The agent name for the User-Agent: the option (milestone 4's MCP server passes the client
// name), else $GRILL_ME_AGENT, else "claude-code" when CLAUDECODE=1. Nothing else is detected.
const AGENT_NAME = /^[a-z0-9-]{1,32}$/;
export function resolveAgent(explicit) {
  if (explicit && AGENT_NAME.test(explicit)) return explicit;
  const envAgent = process.env.GRILL_ME_AGENT;
  if (envAgent && AGENT_NAME.test(envAgent)) return envAgent;
  if (process.env.CLAUDECODE === "1") return "claude-code";
  return undefined;
}
