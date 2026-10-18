// The MCP protocol, with no I/O: shared by the local stdio server (milestone 4) and the hosted
// HTTP server (milestone 4b). Browser-safe like the rest of core. The transport keeps one ctx per
// connection; ctx carries clientInfo (from initialize) and an AbortSignal signal per call.
import { GRILL_SCHEMA } from "./format.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"]; // newest first

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// createMcpHandler({ name, version, instructions, tools }) → { handle(message, ctx) }.
// tools: [{ name, title, description, inputSchema, annotations, run(args, ctx) }]; run returns
// { text, structured }. handle returns a promise of the response object, or null for notifications.
export function createMcpHandler({ name, version, instructions, tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  const handle = async (message, ctx = {}) => {
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return error(isObject(message) && "id" in message ? message.id : null, -32600, "invalid JSON-RPC request");
    }
    const { id, method, params } = message;
    if (!("id" in message)) {
      return null; // a notification: never answered (initialized, cancelled, …)
    }

    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return result(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });
      }
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, {
          tools: tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        });
      case "tools/call": {
        if (!isObject(params) || typeof params.name !== "string") {
          return error(id, -32602, "tools/call needs params.name");
        }
        const tool = byName.get(params.name);
        if (!tool) return error(id, -32602, `unknown tool "${params.name}"`);
        if (params.arguments !== undefined && !isObject(params.arguments)) {
          return error(id, -32602, "tools/call arguments must be an object");
        }
        try {
          const out = await tool.run(params.arguments ?? {}, ctx);
          return result(id, {
            content: [{ type: "text", text: out.text }],
            structuredContent: out.structured,
          });
        } catch (err) {
          // a tool that throws becomes a tool result with isError, not a JSON-RPC error
          return result(id, {
            content: [{ type: "text", text: String(err?.message || err) }],
            isError: true,
          });
        }
      }
      default:
        return error(id, -32601, `method not found: ${method}`);
    }
  };

  return { handle };
}

const TRUTHFUL = { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false };

const SEND_DESCRIPTION =
  "Ask the user two or more questions as swipe cards on their phone (one question: just ask it in chat). " +
  "Pass exactly one of grill (the structured format) or text (grill text: '❓ Q1 - <title>' lines, a body and " +
  "choice bullets, a '➡️ <recommendation>' line, questions separated by ---). Show the returned link as plain " +
  "text and the QR in a code block, then call grill_wait with the id to collect the answers.";

// grillToolDefs({ mode: "local" | "hosted", waitSeconds?: { default, max } }) → the three tool
// definitions, without run. waitSeconds fills the real numbers into the local seconds description.
export function grillToolDefs({ mode, waitSeconds }) {
  if (mode !== "local" && mode !== "hosted") throw new Error('mode must be "local" or "hosted"');
  const hosted = mode === "hosted";

  const send = {
    name: "grill_send",
    title: "Send a grill",
    description: SEND_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        grill: GRILL_SCHEMA,
        text: {
          type: "string",
          description: "The questions in grill text format. Exactly one of grill / text is required.",
        },
        title: { type: "string", description: "Optional short name for the whole grill." },
      },
    },
    annotations: { ...TRUTHFUL },
  };

  const wait = {
    name: "grill_wait",
    title: "Wait for the answers",
    description:
      "Wait up to seconds for the user to answer on their phone. On WAITING, call again with the same " +
      "arguments. On ANSWERS, the answer lines follow ('Q<n> - …'). EXPIRED means the grill is gone — offer to " +
      "send it again with grill_send." +
      (hosted ? "" : " OFFLINE means grill-me.ai can't be reached; the answers stay on the server for an hour."),
    inputSchema: {
      type: "object",
      properties: hosted
        ? {
            link: { type: "string", description: "The full grill link from grill_send. Pass link, or id + secret." },
            id: { type: "string", description: "The grill id (with secret, instead of link)." },
            secret: { type: "string", description: "The grill secret (with id, instead of link)." },
            seconds: { type: "integer", description: "How long to wait (default 45, capped)." },
          }
        : {
            id: { type: "string", description: "The grill id from grill_send." },
            seconds: {
              type: "integer",
              description: waitSeconds
                ? `How long to wait (default ${waitSeconds.default}, max ${waitSeconds.max}).`
                : "How long to wait (default 45, capped at 900).",
            },
          },
      ...(hosted ? {} : { required: ["id"] }),
    },
    annotations: { ...TRUTHFUL },
  };

  const cancel = {
    name: "grill_cancel",
    title: "Cancel a grill",
    description:
      "Delete the grill on the server, e.g. when the user answered in chat instead. " +
      (hosted ? "Pass link, or id + secret." : "Pass the grill id."),
    inputSchema: {
      type: "object",
      properties: hosted
        ? {
            link: { type: "string", description: "The full grill link from grill_send. Pass link, or id + secret." },
            id: { type: "string", description: "The grill id (with secret, instead of link)." },
            secret: { type: "string", description: "The grill secret (with id, instead of link)." },
          }
        : {
            id: { type: "string", description: "The grill id from grill_send." },
          },
      ...(hosted ? {} : { required: ["id"] }),
    },
    annotations: { ...TRUTHFUL },
  };

  return [send, wait, cancel];
}

// clientAgent(clientInfo) maps the MCP clientInfo.name onto the metrics allowlist.
// Loose matching, never free text.
export function clientAgent(clientInfo) {
  const n = String(clientInfo?.name ?? "").toLowerCase();
  const has = (...words) => words.every((w) => n.includes(w));
  if (has("claude") && has("code")) return "claude-code";
  if (has("claude") && has("desktop")) return "claude-desktop";
  if (has("chatgpt")) return "chatgpt";
  if (has("codex")) return "codex";
  if (has("cursor")) return "cursor";
  if (has("gemini")) return "gemini-cli";
  if (has("vscode") || has("visual", "studio") || has("vs", "code")) return "vscode";
  if (has("claude")) return "claude-ai"; // claude.ai web and the mobile apps
  return "other";
}
