// The local MCP server: newline-delimited JSON-RPC on stdin/stdout, built on the library ops.
// stdout carries only JSON-RPC; diagnostics go to stderr, never with tool arguments or results.
// Messages are handled concurrently, so a waiting grill_wait never blocks ping or another call.
import fs from "node:fs/promises";
import { createMcpHandler, grillToolDefs, clientAgent } from "../../core/src/index.js";
import { send, wait, cancel } from "./index.js";
import { writeOutput } from "./output.js";

const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

const INSTRUCTIONS =
  "Grill Me turns questions into phone swipe cards. Use grill_send when the user explicitly asks to be grilled " +
  "(even one clarifying question), or when you have two or more questions. Without an explicit grill request, " +
  "ask a single question in chat. Show every question in full in the usual grill format, then end your reply " +
  "with 'Grill it on your phone' and the returned link as plain text. Do not print a QR code. " +
  "Then call grill_wait with the id. If the user answers in chat instead, call grill_cancel.";

// GRILL_ME_WAIT_SECONDS is both the default and, when set, the cap: each client sets it to fit
// its tool time limit (Desktop 180 < 240 s, Codex 840 < 900), so a larger `seconds` must not
// exceed it. The default never exceeds the local cap of 900. A non-numeric `seconds` falls back
// to the default.
const waitConfig = (env) => {
  const fromEnv = Number(env.GRILL_ME_WAIT_SECONDS);
  const envValid = Number.isFinite(fromEnv) && fromEnv > 0;
  const def = envValid ? Math.min(Math.floor(fromEnv), 900) : 45;
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

const waitResult = (result) => ({
  text: result.status === "ANSWERS"
    ? `${result.lines}\nSTATUS: ANSWERS`
    : `${STATUS_TEXT[result.status]}\nSTATUS: ${result.status}`,
  structured: { status: result.status, ...(result.lines ? { answers: result.lines } : {}) },
});

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
          `Show every question in full in the usual grill format, then end your reply with:\n\n` +
          `Grill it on your phone\n${result.link}\n\n` +
          `Then call grill_wait with id "${result.id}".`,
        structured: { id: result.id, link: result.link, count: result.count, expiresAt: result.expiresAt },
      };
    },

    grill_wait: async (args, ctx) => {
      const seconds = waitSeconds(args.seconds, waitCfg);
      const result = await wait(String(args.id ?? ""), {
        seconds,
        agent: clientAgent(ctx.clientInfo),
        signal: ctx.signal,
      });
      if (result.status === "ANSWERS") ctx.onDelivery(result);
      return waitResult(result);
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
  const write = (obj, signal) => writeOutput(stdout, JSON.stringify(obj) + "\n", signal);
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
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }).catch(() => note("output failed"));
      return;
    }
    if (msg?.method === "initialize" && msg.params?.clientInfo) conn.clientInfo = msg.params.clientInfo;
    if (msg?.method === "notifications/cancelled" && !("id" in msg)) {
      controllers.get(msg.params?.requestId)?.abort();
      return;
    }
    const ctrl = new AbortController();
    let delivery;
    if (msg && typeof msg === "object" && "id" in msg) controllers.set(msg.id, ctrl);
    handler
      .handle(msg, { clientInfo: conn.clientInfo, signal: ctrl.signal, onDelivery: (result) => { delivery = result; } })
      .then(async (res) => {
        if (!res || ctrl.signal.aborted) return;
        if (delivery && !delivery.canDeliver()) {
          delivery.dispose();
          delivery = null;
          const waiting = waitResult({ status: "WAITING" });
          res = { ...res, result: { content: [{ type: "text", text: waiting.text }], structuredContent: waiting.structured } };
        }
        try { await write(res, delivery?.deliverySignal ?? ctrl.signal); }
        catch { note("output interrupted; pending retained"); return; }
        // Reply first. The controller stays registered through cleanup, so cancelled/stdin-end
        // notifications still abort DELETE without blocking ping or any other request.
        if (delivery) {
          try { await delivery.ack(); }
          catch { note("answer cleanup interrupted; pending retained"); }
        }
      })
      .catch(async () => {
        note("internal error");
        if (!ctrl.signal.aborted && msg && "id" in msg) {
          await write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "internal error" } }, ctrl.signal).catch(() => {});
        }
      })
      .finally(() => { delivery?.dispose(); controllers.delete(msg?.id); });
  };

  return new Promise((resolve) => {
    stdin.on("end", () => {
      for (const ctrl of controllers.values()) ctrl.abort();
      resolve();
    });
    stdin.resume();
  });
}
