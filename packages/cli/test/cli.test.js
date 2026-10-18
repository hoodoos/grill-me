import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_TEXT } from "../../core/src/index.js";
import { startFakeServer } from "./fake-server.js";
import { phoneAnswer } from "./phone.js";

const BIN = fileURLToPath(new URL("../bin/grill-me.js", import.meta.url));

function run(args, { input, home, server } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args, ...(server ? ["--server", server] : [])], {
      env: { ...process.env, GRILL_ME_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "grill-me-cli-"));
  const fake = await startFakeServer();
  t.after(async () => {
    await fake.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, server: fake.url, fake };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sentId = (stdout) => /^id: ([A-Za-z0-9_-]{16})$/m.exec(stdout)?.[1];

test("--version and --help", async (t) => {
  const { home } = await fixture(t);
  const v = await run(["--version"], { home });
  assert.equal(v.stdout.trim(), "0.1.0");
  assert.equal(v.code, 0);

  const h = await run(["--help"], { home });
  assert.match(h.stdout, /Usage:/);
  assert.equal(h.code, 0);

  const none = await run([], { home });
  assert.equal(none.code, 2);

  const bogus = await run(["frobnicate"], { home });
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /unknown command/);
});

test("send reads stdin and prints the exact block", async (t) => {
  const { home, server } = await fixture(t);
  const r = await run(["send", "-", "--qr", "off"], { input: DEMO_TEXT, home, server });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "Grill Me: 4 questions, answer within 1 hour.");
  assert.match(lines[1], new RegExp(`^${server}/g/[A-Za-z0-9_-]{16}#[A-Za-z0-9_-]{22}$`));
  assert.equal(lines[2], "");
  assert.match(lines[3], /^id: [A-Za-z0-9_-]{16}$/);
  const id = sentId(r.stdout);
  assert.ok(await fs.stat(path.join(home, "pending", `${id}.json`)), "pending file written");
});

test("send prints the QR by default and JSON with --json", async (t) => {
  const { home, server } = await fixture(t);
  const plain = await run(["send", "-"], { input: DEMO_TEXT, home, server });
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(plain.stdout.includes("▀") || plain.stdout.includes("▄") || plain.stdout.includes("█"), "QR in output");
  assert.ok(sentId(plain.stdout));

  const json = await run(["send", "-", "--json"], { input: DEMO_TEXT, home, server });
  assert.equal(json.code, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.count, 4);
  assert.equal(typeof result.qr, "string");
  assert.match(result.link, /^http/);
  assert.match(result.id, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(result.expiresAt);
});

test("send with bad input prints the schema and exits 2", async (t) => {
  const { home, server } = await fixture(t);
  const r = await run(["send", "-"], { input: "no questions here", home, server });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no questions found/);
  assert.match(r.stderr, /Expected schema:/);
  assert.match(r.stderr, /"questions"/);
  assert.equal(r.stdout, "");
});

test("fetch → WAITING, then wait → ANSWERS with the exact status line", async (t) => {
  const { home, server } = await fixture(t);
  const sent = await run(["send", "-", "--qr", "off"], { input: DEMO_TEXT, home, server });
  const id = sentId(sent.stdout);
  const pending = JSON.parse(await fs.readFile(path.join(home, "pending", `${id}.json`), "utf8"));

  const waiting = await run(["fetch", id], { home, server });
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.equal(waiting.stdout, `No answers yet.\nSTATUS: WAITING\n`);

  const answering = sleep(250).then(() =>
    phoneAnswer(server, id, pending.secret, [
      { n: 1, kind: "agree" },
      { n: 2, kind: "choice", choice: "Always dark" },
      { n: 3, kind: "own", text: "A week." },
      { n: 4, kind: "skip" },
    ]),
  );
  const done = await run(["wait", id], { home, server });
  await answering;
  assert.equal(done.code, 0, done.stderr);
  assert.ok(done.stdout.endsWith("STATUS: ANSWERS\n"), done.stdout);
  assert.match(done.stdout, /Q1 - agree\n/);
  assert.match(done.stdout, /Q2 - Always dark\n/);
  assert.match(done.stdout, /Q3 - A week\.\n/);
  assert.match(done.stdout, /Q4 - skip for now, ask again later\n/);
  await assert.rejects(fs.stat(path.join(home, "pending", `${id}.json`)), { code: "ENOENT" });
});

test("expired grill → EXPIRED with the resend hint, then resend and cancel", async (t) => {
  const { home, server, fake } = await fixture(t);
  const sent = await run(["send", "-", "--qr", "off"], { input: DEMO_TEXT, home, server });
  const id = sentId(sent.stdout);
  fake.expire(id);

  const expired = await run(["wait", id], { home, server });
  assert.equal(expired.code, 0, expired.stderr);
  assert.equal(
    expired.stdout,
    `The grill expired before it was answered. Send it again with: npx -y grill-me-ai resend ${id}\nSTATUS: EXPIRED\n`,
  );

  const resent = await run(["resend", id, "--qr", "off"], { home, server });
  assert.equal(resent.code, 0, resent.stderr);
  const newId = sentId(resent.stdout);
  assert.notEqual(newId, id);
  assert.match(resent.stdout, /Grill Me: 4 questions, answer within 1 hour\./);

  const cancelled = await run(["cancel", newId], { home, server });
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.stdout, `Cancelled ${newId}.\nSTATUS: CANCELLED\n`);
});

test("an unknown id exits 2 with a clear message", async (t) => {
  const { home, server } = await fixture(t);
  const r = await run(["wait", "Abcd1234_efgh-ij"], { home, server });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /another machine|already fetched/);
});

test("mcp is a placeholder that exits 1", async (t) => {
  const { home } = await fixture(t);
  const r = await run(["mcp"], { home });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /coming in the next release/);
});
