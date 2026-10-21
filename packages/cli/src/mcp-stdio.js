// The local MCP server: newline-delimited JSON-RPC on stdin/stdout, built on the library ops.
// stdout carries only JSON-RPC; diagnostics go to stderr, never with tool arguments or results.
// Messages are handled concurrently, so a waiting grill_wait never blocks ping or another call.
import fs from "node:fs/promises";
import { createMcpHandler, grillToolDefs, clientAgent } from "../../core/src/index.js";
import { send, sendRound, wait, cancel, finish } from "./index.js";
import { writeOutput } from "./output.js";
import { EXPIRY_HELP, RESUME_HELP, RESUME_WORKFLOW, waitHelp } from "../../core/src/recovery.js";

const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

// The complete upstream skill is shipped verbatim; clients without a plugin receive it here.
const GRILLING = (await fs.readFile(new URL("../../core/src/grilling.md", import.meta.url), "utf8"))
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/, "");

const INSTRUCTIONS =
  "Grill Me turns questions into phone swipe cards. Use grill_send when the user explicitly asks to be grilled " +
  "(even one clarifying question), or when you have two or more questions. Without an explicit grill request, " +
  "ask a single question in chat. Follow Matt Pocock’s complete grilling skill below, including its exact format. " +
  "Show every question in full, then end your reply " +
  "with 'Grill it on your phone' and the returned link as plain text. Do not print a QR code. " +
  "For an interview use session:true on grill_send, retain its explicit id and publish subsequent ready " +
  "frontier rounds with that id and the next round number. Never silently attach another interview. " +
  "The same phone link waits and updates automatically. PUBLISHING is unconfirmed: retry the exact saved " +
  "id/round/questions rather than creating another session or claiming the phone is ready. " +
  "Then call grill_wait with the id. After shared-understanding confirmation call grill_finish. " +
  "If the user answers in chat instead, call grill_cancel.\n\n" +
  "Matt Pocock’s complete grilling skill (MIT):\n\n" + GRILLING + "\n\n" + RESUME_WORKFLOW;

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
  EXPIRED: "This interview ended or expired. Check this chat for explicit finish/cancel before resending only its last unanswered frontier on a fresh link. " + RESUME_HELP,
  OFFLINE: "Couldn't reach grill-me.ai for 5 minutes. The answers stay on the server for up to an hour; call grill_wait again to check.",
  WAITING: "No answers yet. This wait ended; the interview may still be live. Continue bounded waits only while this host turn is active.",
};

const waitResult = (result, seconds) => ({
  text: result.status === "ANSWERS"
    ? `${result.lines}\nSTATUS: ANSWERS`
    : `${result.message ?? STATUS_TEXT[result.status] ?? result.status}${seconds ? "\n" + waitHelp(seconds) : ""}\nSTATUS: ${result.status}`,
  structured: { status: result.status, ...(seconds && result.status !== "ANSWERS" ? { waitSeconds: seconds, resumeCommand: "Resume Grill Me" } : {}), ...(result.lines ? { answers: result.lines } : {}),
    ...Object.fromEntries(["session", "id", "round", "revision", "state", "submissionId", "link"].filter(k => result[k] !== undefined).map(k => [k, result[k]])) },
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
        if (args.session !== undefined && typeof args.session !== "boolean") throw new Error("session must be boolean");
        result = await (args.session || args.id !== undefined ? sendRound : send)(hasGrill ? args.grill : args.text, {
          title: args.title,
          agent: clientAgent(ctx.clientInfo),
          id: args.id, round: args.round, expectedRevision: args.expectedRevision, signal: ctx.signal,
        });
      } catch (err) {
        if (err.code === "input") {
          throw new Error(`${err.message}\nExpected schema:\n${JSON.stringify(err.schema, null, 2)}`);
        }
        throw err;
      }
      if (result.status === "PUBLISHING") return { text: `UNCONFIRMED publication. ${result.message}\nDo not present the phone as ready. Retry this saved id/round with the same questions.\nSTATUS: PUBLISHING`, structured: result };
      if (result.state === "idle") return { text: "Publication confirmed; this round has already been collected. Publish the next ready frontier with this id or finish after confirmation.\nSTATUS: IDLE", structured: result };
      return {
        text:
          `Show the complete frontier round in Matt Pocock’s exact grilling format, then end your reply with:\n\n` +
          `Grill it on your phone\n${result.link}\n\n` +
          `${waitHelp(waitCfg.default)} ${EXPIRY_HELP}\nShow this wait limit and resume instruction to the user BEFORE waiting. Then call grill_wait with id "${result.id}".`,
        structured: { ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "qr")), waitSeconds: waitCfg.default, maxWaitSeconds: waitCfg.max, resumeCommand: "Resume Grill Me" },
      };
    },

    grill_wait: async (args, ctx) => {
      const seconds = waitSeconds(args.seconds, waitCfg);
      const result = await wait(String(args.id ?? ""), {
        seconds,
        round: args.round,
        agent: clientAgent(ctx.clientInfo),
        signal: ctx.signal,
      });
      if (result.status === "ANSWERS") ctx.onDelivery(result);
      return waitResult(result, seconds);
    },

    grill_cancel: async (args, ctx) => {
      const id = String(args.id ?? "");
      await cancel(id, { agent: clientAgent(ctx.clientInfo) });
      return { text: `Cancelled ${id}.`, structured: { status: "CANCELLED" } };
    },
    grill_finish: async (args, ctx) => {
      const result = await finish(String(args.id ?? ""), { expectedRevision: args.expectedRevision, agent: clientAgent(ctx.clientInfo), signal: ctx.signal });
      return { text: `Session ${result.status.toLowerCase()}.`, structured: result };
    },
  };
  return grillToolDefs({ mode: "local", waitSeconds: waitCfg }).map((def) => ({ ...def, run: runs[def.name] }));
}

// Starts the server; resolves when stdin closes. Diagnostics (never arguments or results) to stderr.
export function startStdioServer({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const handler = createMcpHandler({ name: "grill-me", version: pkg.version, instructions: INSTRUCTIONS + "\n\n" + waitHelp(waitConfig(env).default) + " " + EXPIRY_HELP + " Show the actual selected wait limit before waiting; host timeouts may end a call earlier.", tools: localTools(env) });
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
