// The local MCP server: newline-delimited JSON-RPC on stdin/stdout, built on the library ops.
// stdout carries only JSON-RPC; diagnostics go to stderr, never with tool arguments or results.
// Messages are handled concurrently, so a waiting grill_wait never blocks ping or another call.
import fs from "node:fs/promises";
import { createMcpHandler, grillToolDefs, clientAgent } from "../../core/src/index.js";
import { send, wait, cancel } from "./index.js";

const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

const INSTRUCTIONS =
  "Grill Me turns your questions for the user into swipe cards on their phone. Use grill_send when you have " +
  "2 or more questions (one question: just ask in chat). Show the link as plain text and the QR in a code " +
  "block, then call grill_wait with the id. If the user answers in chat instead, call grill_cancel.";

// GRILL_ME_WAIT_SECONDS is both the default and, when set, the cap: each client sets it to fit
// its tool time limit (Desktop 180 < 240 s, Codex 840 < 900), so a larger `seconds` must not
// exceed it. Without the env the cap is 900. A non-numeric `seconds` falls back to the default.
const waitConfig = (env) => {
  const fromEnv = Number(env.GRILL_ME_WAIT_SECONDS);
  const envValid = Number.isFinite(fromEnv) && fromEnv > 0;
  const def = envValid ? Math.floor(fromEnv) : 45;
  return { default: def, max: envValid ? def : 900 };
};

const waitSeconds = (arg, { default: def, max }) => {
  const n = arg === undefined || arg === null ? NaN : Number(arg);
  const chosen = Number.isFinite(n) ? n : def;
  return Math.min(max, Math.max(1, Math.floor(chosen)));
};

const STATUS_TEXT = {
  EXPIRED: "The grill expired before it was answered. Offer to send the questions again with grill_send.",
  OFFLINE: "Couldn't reach grill-me.ai for 5 minutes. The answers stay on the server for up to an hour; call grill_wait again to check.",
  WAITING: "No answers yet. Call grill_wait again with the same arguments to keep waiting.",
};

function localTools(env) {
  const waitCfg = waitConfig(env);
  const runs = {
    grill_send: async (args, ctx) => {
      const hasGrill = args.grill !== undefined;
      const hasText = args.text !== undefined;
      if (hasGrill === hasText) throw new Error("pass exactly one of grill / text");
      let result;
      try {
        result = await send(hasGrill ? args.grill : args.text, {
          title: args.title,
          agent: clientAgent(ctx.clientInfo),
        });
      } catch (err) {
        if (err.code === "input") {
          throw new Error(`${err.message}\nExpected schema:\n${JSON.stringify(err.schema, null, 2)}`);
        }
        throw err;
      }
      return {
        text:
          `${result.link}\n\n\`\`\`\n${result.qr}\n\`\`\`\n\n` +
          `Show the link as plain text and the QR in a code block, then call grill_wait with id "${result.id}".`,
        structured: result,
      };
    },

    grill_wait: async (args, ctx) => {
      const seconds = waitSeconds(args.seconds, waitCfg);
      const result = await wait(String(args.id ?? ""), {
        seconds,
        agent: clientAgent(ctx.clientInfo),
        signal: ctx.signal,
      });
      const text =
        result.status === "ANSWERS"
          ? `${result.lines}\nSTATUS: ANSWERS`
          : `${STATUS_TEXT[result.status]}\nSTATUS: ${result.status}`;
      return { text, structured: { status: result.status, ...(result.lines ? { answers: result.lines } : {}) } };
    },

    grill_cancel: async (args, ctx) => {
      const id = String(args.id ?? "");
      await cancel(id, { agent: clientAgent(ctx.clientInfo) });
      return { text: `Cancelled ${id}.`, structured: { status: "CANCELLED" } };
    },
  };
  return grillToolDefs({ mode: "local", waitSeconds: waitCfg }).map((def) => ({ ...def, run: runs[def.name] }));
}

// Starts the server; resolves when stdin closes. Diagnostics (never arguments or results) to stderr.
export function startStdioServer({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const handler = createMcpHandler({ name: "grill-me", version: pkg.version, instructions: INSTRUCTIONS, tools: localTools(env) });
  const conn = { clientInfo: undefined };
  const controllers = new Map(); // request id → AbortController
  const write = (obj) => stdout.write(JSON.stringify(obj) + "\n");
  const note = (s) => stderr.write(`grill-me mcp: ${s}\n`);

  stdin.setEncoding("utf8");
  let buffer = "";
  stdin.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) onLine(line);
    }
  });

  const onLine = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      note("ignoring a malformed line");
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (msg?.method === "initialize" && msg.params?.clientInfo) conn.clientInfo = msg.params.clientInfo;
    if (msg?.method === "notifications/cancelled" && !("id" in msg)) {
      controllers.get(msg.params?.requestId)?.abort();
      return;
    }
    const ctrl = new AbortController();
    if (msg && typeof msg === "object" && "id" in msg) controllers.set(msg.id, ctrl);
    handler
      .handle(msg, { clientInfo: conn.clientInfo, signal: ctrl.signal })
      .then((res) => {
        if (res && !ctrl.signal.aborted) write(res); // a cancelled call's answer is moot
      })
      .catch((err) => {
        note(`internal error: ${err?.message || err}`);
        if (!ctrl.signal.aborted && msg && "id" in msg) {
          write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "internal error" } });
        }
      })
      .finally(() => controllers.delete(msg?.id));
  };

  return new Promise((resolve) => {
    stdin.on("end", () => {
      for (const ctrl of controllers.values()) ctrl.abort();
      resolve();
    });
    stdin.resume();
  });
}
