// The grill-me command. The library (src/index.js) does the work; this file only parses and prints.
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { send, wait, check, resend, cancel } from "./index.js";
import { isId } from "../../core/src/index.js";
import { writeOutput } from "./output.js";

const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

const HELP = `grill-me — your agent's questions as swipe cards on your phone

Usage:
  grill-me send [file|-] [--title T] [--qr dark|light|off] [--json]
  grill-me wait <id>
  grill-me fetch <id>
  grill-me resend <id> [--qr dark|light|off] [--json]
  grill-me cancel <id>
  grill-me mcp

Options:
  --server URL   grill server (default: $GRILL_ME_SERVER or https://grill-me.ai)
  --help         show this help
  --version      show the version

send reads stdin when no file is given and stdin isn't a terminal.`;

class UsageError extends Error {}

function parse(argv, options, { min = 0, max = 1, takesId = false } = {}) {
  // Grill ids can start with '-' or '--', which parseArgs would reject as unknown
  // options. The id shape (16 canonical base64url chars) matches no option name
  // or value, so pull the id out before parseArgs runs — but only for the commands
  // that take an id; for send, a 16-character file name is a file, not an id.
  const args = [...argv];
  const at = takesId ? args.findIndex(isId) : -1;
  const id = at === -1 ? undefined : args.splice(at, 1)[0];
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const positionals = id === undefined ? parsed.positionals : [id, ...parsed.positionals];
  if (positionals.length < min || positionals.length > max) throw new UsageError("wrong number of arguments");
  return { ...parsed, positionals };
}

async function readStdin(stdin) {
  // Buffer.concat, not string +=: a multi-byte character split across chunks must not corrupt.
  const chunks = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function withinPhrase(expiresAt) {
  // the real server sends epoch milliseconds; an ISO string is accepted defensively
  const at = typeof expiresAt === "number" ? expiresAt : Date.parse(expiresAt);
  const ms = at - Date.now();
  const minutes = Number.isNaN(ms) ? 60 : Math.max(1, Math.round(ms / 60000));
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours > 1 ? "s" : ""}`;
  }
  if (minutes > 90) return `${Math.round(minutes / 60)} hours`;
  return `${minutes} minutes`;
}

function printSend(out, result) {
  out(`Grill Me: ${result.count} question${result.count === 1 ? "" : "s"}, answer within ${withinPhrase(result.expiresAt)}.`);
  out(result.link);
  out("");
  if (result.qr !== null) {
    out(result.qr);
    out("");
  }
  out(`id: ${result.id}`);
}

async function run(argv, { stdout, stderr, stdin } = {}) {
  const out = (s = "") => stdout.write(s + "\n");
  const err = (s = "") => stderr.write(s + "\n");
  const [cmd, ...rest] = argv;

  if (cmd === "--version" || cmd === "-v") {
    out(pkg.version);
    return 0;
  }
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    out(HELP);
    return cmd ? 0 : 2;
  }

  const serverOpt = { server: { type: "string" } };

  try {
    switch (cmd) {
      case "send": {
        const { values, positionals } = parse(rest, {
          title: { type: "string" },
          qr: { type: "string" },
          json: { type: "boolean" },
          ...serverOpt,
        });
        if (values.qr !== undefined && !["dark", "light", "off"].includes(values.qr)) {
          throw new UsageError("--qr must be dark, light or off");
        }
        const [file] = positionals;
        let input;
        if (file && file !== "-") input = await fs.readFile(file, "utf8");
        else if (!file && stdin.isTTY) throw new UsageError("send needs a file, -, or piped stdin");
        else input = await readStdin(stdin);
        const result = await send(input, { title: values.title, server: values.server, qr: values.qr ?? "dark" });
        if (values.json) out(JSON.stringify(result, null, 2));
        else printSend(out, result);
        return 0;
      }

      case "wait":
      case "fetch": {
        const { values, positionals } = parse(rest, { ...serverOpt }, { takesId: true });
        const [id] = positionals;
        let result = await (cmd === "wait" ? wait(id, { server: values.server }) : check(id, { server: values.server }));
        if (result.status === "ANSWERS") {
          try {
            if (result.canDeliver()) {
              await writeOutput(stdout, `${result.lines}\nSTATUS: ANSWERS\n`, result.deliverySignal);
              try { await result.ack(); }
              catch { err("grill-me: answers delivered; cleanup failed, encrypted answers kept for retry."); }
              return 0;
            }
          } finally {
            result.dispose();
          }
          result = { status: "WAITING" };
        }
        switch (result.status) {
          case "EXPIRED":
            out(`The grill expired before it was answered. Send it again with: npx -y grill-me-ai resend ${id}`);
            break;
          case "OFFLINE":
            out(`Couldn't reach grill-me.ai for 5 minutes. The answers stay there for up to an hour; check again with: npx -y grill-me-ai fetch ${id}`);
            break;
          case "WAITING":
            out("No answers yet.");
            break;
        }
        out(`STATUS: ${result.status}`);
        return 0;
      }

      case "resend": {
        const { values, positionals } = parse(rest, {
          qr: { type: "string" },
          json: { type: "boolean" },
          ...serverOpt,
        }, { takesId: true });
        if (values.qr !== undefined && !["dark", "light", "off"].includes(values.qr)) {
          throw new UsageError("--qr must be dark, light or off");
        }
        const [id] = positionals;
        const result = await resend(id, { server: values.server, qr: values.qr ?? "dark" });
        if (values.json) out(JSON.stringify(result, null, 2));
        else printSend(out, result);
        return 0;
      }

      case "cancel": {
        const { values, positionals } = parse(rest, { ...serverOpt }, { takesId: true });
        const [id] = positionals;
        await cancel(id, { server: values.server });
        out(`Cancelled ${id}.`);
        out("STATUS: CANCELLED");
        return 0;
      }

      case "mcp": {
        parse(rest, {}, { max: 0 });
        const { startStdioServer } = await import("./mcp-stdio.js");
        await startStdioServer({ stdin, stdout, stderr });
        return 0;
      }

      default:
        err(`grill-me: unknown command "${cmd}"`);
        err(HELP);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      err(`grill-me ${cmd}: ${error.message}`);
      err(`Try 'grill-me --help'.`);
      return 2;
    }
    if (error.code === "input") {
      err(`grill-me: ${error.message}`);
      err("Expected schema:");
      err(JSON.stringify(error.schema, null, 2));
      return 2;
    }
    if (error.code === "unknown-id") {
      err(`grill-me: ${error.message}`);
      return 2;
    }
    err(`grill-me: ${error.message}`);
    return 1;
  }
}

export async function main(argv, streams) {
  return run(argv, { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, ...streams });
}
