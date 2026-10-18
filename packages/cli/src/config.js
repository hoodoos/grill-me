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
