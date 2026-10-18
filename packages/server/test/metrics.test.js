import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer, mapAgentName } from "../src/server.js";
import { convert, DEMO_TEXT, newId, newSecret, sealGrill, sealAnswers, deriveKeys } from "../../core/src/index.js";

const TOKEN = "t".repeat(40);

// Belt and braces: a failing assertion skips a test's own close(), so close every
// server here too — otherwise the listener keeps the whole file from exiting.
const closers = [];
after(async () => { for (const c of closers.splice(0)) await c().catch(() => {}); });

async function start(opts = {}) {
  const logs = [];
  const s = createServer({
    db: opts.db ?? ":memory:",
    log: (l) => logs.push(l),
    statsToken: "statsToken" in opts ? opts.statsToken : TOKEN,
    ...opts,
  });
  closers.push(s.close);
  await new Promise((r) => s.server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${s.server.address().port}`, close: s.close, logs };
}

async function mkGrill(base, { ua, qb } = {}) {
  const grill = convert(DEMO_TEXT).grill;
  const id = newId(), secret = newSecret();
  const sealed = await sealGrill(grill, { id, secret });
  const r = await fetch(`${base}/api/g`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ua ? { "user-agent": ua } : {}) },
    body: JSON.stringify({ id, ...sealed, ...(qb ? { qb } : {}) }),
  });
  assert.equal(r.status, 201);
  return { id, secret, grill };
}

const statsRows = async (base) => {
  const r = await fetch(`${base}/stats/data.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  return (await r.json()).days;
};
const count = (rows, name, bucket = "") =>
  rows.filter((r) => r.name === name && r.bucket === bucket).reduce((s, r) => s + r.count, 0);

test("the funnel counters: created, opened (once), answered, picked_up, cancelled, hub_click", async () => {
  const { base, close } = await start();
  const g1 = await mkGrill(base);
  const g2 = await mkGrill(base);
  assert.equal(count(await statsRows(base), "created"), 2);

  // opened: the first GET only, a reload doesn't count twice
  await fetch(`${base}/api/g/${g1.id}`);
  await fetch(`${base}/api/g/${g1.id}`);
  assert.equal(count(await statsRows(base), "opened"), 1);

  // answered + picked_up on g1; cancelled on g2
  const { writeToken } = await deriveKeys(g1.secret);
  const blob = await sealAnswers({ v: 1, answers: g1.grill.questions.map((q) => ({ n: q.n, kind: "skip" })) }, g1.grill, g1);
  await fetch(`${base}/api/g/${g1.id}/answers`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` }, body: JSON.stringify(blob),
  });
  await fetch(`${base}/api/g/${g1.id}`, { method: "DELETE", headers: { authorization: `Bearer ${writeToken}` } });
  const w2 = await deriveKeys(g2.secret);
  await fetch(`${base}/api/g/${g2.id}`, { method: "DELETE", headers: { authorization: `Bearer ${w2.writeToken}` } });
  const go = await fetch(`${base}/go/hub`, { redirect: "manual" });
  assert.equal(go.status, 302);
  assert.equal(go.headers.get("location"), "/hub");

  const rows = await statsRows(base);
  assert.equal(count(rows, "answered"), 1);
  assert.equal(count(rows, "picked_up"), 1);
  assert.equal(count(rows, "cancelled"), 1);
  assert.equal(count(rows, "hub_click"), 1);
  await close();
});

test("sweeper counts expired_unanswered and expired_answered", async () => {
  const { base, close } = await start({ ttlMs: 120, sweepMs: 30 });
  const g1 = await mkGrill(base);
  await mkGrill(base);
  const { writeToken } = await deriveKeys(g1.secret);
  const blob = await sealAnswers({ v: 1, answers: g1.grill.questions.map((q) => ({ n: q.n, kind: "skip" })) }, g1.grill, g1);
  await fetch(`${base}/api/g/${g1.id}/answers`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` }, body: JSON.stringify(blob),
  });
  await new Promise((r) => setTimeout(r, 400));
  const rows = await statsRows(base);
  assert.equal(count(rows, "expired_answered"), 1);
  assert.equal(count(rows, "expired_unanswered"), 1);
  await close();
});

test("time buckets with an injected clock", async () => {
  let t = 1_700_000_000_000;
  const { base, close } = await start({ now: () => t, sweepMs: 3_600_000 });
  const g = await mkGrill(base);
  t += 45_000; // opened within a minute
  await fetch(`${base}/api/g/${g.id}`);
  t += 10 * 60_000; // answered at 5-15m
  const { writeToken } = await deriveKeys(g.secret);
  const blob = await sealAnswers({ v: 1, answers: g.grill.questions.map((q) => ({ n: q.n, kind: "skip" })) }, g.grill, g);
  await fetch(`${base}/api/g/${g.id}/answers`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` }, body: JSON.stringify(blob),
  });
  const rows = await statsRows(base);
  assert.equal(count(rows, "time_to_open", "<1m"), 1);
  assert.equal(count(rows, "time_to_answer", "5-15m"), 1);
  await close();
});

test("grill_size and questions buckets; a bad qb is ignored", async () => {
  const { base, close } = await start();
  await mkGrill(base, { qb: "2-3" });
  await mkGrill(base, { qb: "bogus" });
  await mkGrill(base);
  const rows = await statsRows(base);
  assert.equal(count(rows, "questions", "2-3"), 1);
  const qTotal = rows.filter((r) => r.name === "questions").reduce((s, r) => s + r.count, 0);
  assert.equal(qTotal, 1, "a bogus or absent qb records nothing");
  // the demo grill's ciphertext is a few KB
  assert.equal(count(rows, "grill_size", "1-2k") + count(rows, "grill_size", "2-5k"), 3);
  await close();
});

test("agent allowlist and version parsing from User-Agent", async () => {
  const { base, close } = await start();
  await mkGrill(base, { ua: "grill-me-ai/1.2.3 (claude-code)" });
  await mkGrill(base, { ua: "grill-me-ai/2.0.0 (codex)" });
  await mkGrill(base, { ua: "grill-me-ai/1.2.3 (not-a-real-agent)" });
  await mkGrill(base, { ua: "grill-me-ai/beta (codex)" }); // bad version → other
  await mkGrill(base, { ua: "curl/8.0" }); // → unknown / other
  const rows = await statsRows(base);
  assert.equal(count(rows, "agent", "claude-code"), 1);
  assert.equal(count(rows, "agent", "codex"), 2); // "beta" still names its agent
  assert.equal(count(rows, "agent", "unknown"), 2);
  assert.equal(count(rows, "cli_version", "1.2.3"), 2);
  assert.equal(count(rows, "cli_version", "2.0.0"), 1);
  assert.equal(count(rows, "cli_version", "other"), 2);
  await close();
});

test("the 21st distinct version in a day counts as other", async () => {
  const { base, close } = await start();
  for (let i = 0; i < 21; i++) await mkGrill(base, { ua: `grill-me-ai/1.0.${i} (codex)` });
  const rows = await statsRows(base);
  let distinct = 0;
  for (const r of rows) if (r.name === "cli_version" && r.bucket !== "other") distinct++;
  assert.equal(distinct, 20);
  assert.equal(count(rows, "cli_version", "other"), 1);
  await close();
});

test("mapAgentName maps MCP clientInfo names onto the allowlist", async () => {
  assert.equal(mapAgentName("claude-code"), "claude-code");
  assert.equal(mapAgentName("Codex CLI"), "codex");
  assert.equal(mapAgentName("Visual Studio Code"), "vscode");
  assert.equal(mapAgentName("something-else"), "unknown");
  assert.equal(mapAgentName(undefined), "unknown");
});

test("pruning: days older than 400 are dropped by the sweeper", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grill-me-stats-"));
  const file = path.join(dir, "s.db");
  let t = Date.now() - 401 * 86400000;
  const { base, close } = await start({ db: file, now: () => t, sweepMs: 40 });
  await mkGrill(base);
  const oldDay = new Date(t).toISOString().slice(0, 10);
  const readDays = () => {
    const d = new DatabaseSync(file, { readOnly: true });
    const rows = d.prepare("SELECT DISTINCT day FROM stats").all().map((r) => r.day);
    d.close();
    return rows;
  };
  assert.ok(readDays().includes(oldDay));
  t = Date.now(); // jump 401 days forward; the grill expires and the sweeper prunes
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!readDays().includes(oldDay));
  await close();
  await rm(dir, { recursive: true, force: true });
});

test("no metric name or bucket ever contains an id or an IP", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grill-me-stats-"));
  const file = path.join(dir, "s.db");
  const { base, close } = await start({ db: file });
  const g = await mkGrill(base, { ua: "grill-me-ai/1.0.0 (codex)", qb: "4-6" });
  await fetch(`${base}/api/g/${g.id}`, { headers: { "x-real-ip": "198.51.100.23" } });
  await fetch(`${base}/go/hub`, { redirect: "manual" });
  await close();
  const d = new DatabaseSync(file, { readOnly: true });
  const rows = d.prepare("SELECT day, name, bucket FROM stats").all();
  d.close();
  assert.ok(rows.length > 5);
  for (const r of rows) {
    for (const field of [r.day, r.name, r.bucket]) {
      assert.ok(!field.includes(g.id), `${r.name}/${r.bucket} contains the id`);
      assert.ok(!field.includes("198.51.100.23"), `${r.name}/${r.bucket} contains the IP`);
    }
  }
  await rm(dir, { recursive: true, force: true });
});

test("/stats auth: login page, Bearer, cookie flow, rate limit", async () => {
  const { base, close, logs } = await start();
  // no auth → the login page (never data), with noindex + no-store
  const page = await fetch(`${base}/stats`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /type="password"/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}/stats/data.json`)).status, 401);
  assert.equal((await fetch(`${base}/stats/stats.js`)).status, 401);
  assert.equal((await fetch(`${base}/stats/data.json`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  // Bearer
  const ok = await fetch(`${base}/stats/data.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.ok(Array.isArray(data.days) && data.live && data.memory && data.version);
  // login → cookie
  const login = await fetch(`${base}/stats/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /^gm_stats=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.ok(!cookie.includes(TOKEN), "the raw token is never in the cookie");
  const viaCookie = await fetch(`${base}/stats/data.json`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(viaCookie.status, 200);
  const twoCookies = await fetch(`${base}/stats/data.json`, { headers: { cookie: `${cookie.split(";")[0]}; other=1` } });
  assert.equal(twoCookies.status, 200, "gm_stats followed by another cookie still authenticates");
  const authedPage = await fetch(`${base}/stats`, { headers: { cookie: cookie.split(";")[0] } });
  const authedHtml = await authedPage.text();
  assert.match(authedHtml, /id="funnel"/); // the dashboard, not the login page
  assert.ok(!authedHtml.includes('type="password"'));
  // the token never reaches the access log
  for (const l of logs) assert.ok(!l.includes(TOKEN), l);
  await close();
});

test("/stats login: bad token → 401, 6th attempt in a minute → 429", async () => {
  const { base, close } = await start();
  const login = (token) => fetch(`${base}/stats/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
  assert.equal((await login("wrong")).status, 401);
  for (let i = 0; i < 4; i++) await login("wrong");
  assert.equal((await login("wrong")).status, 429);
  assert.equal((await login(TOKEN)).status, 429); // even the right one is refused now
  await close();
});

test("/stats* is 404 without STATS_TOKEN (or a short one)", async () => {
  const { base, close } = await start({ statsToken: "" });
  assert.equal((await fetch(`${base}/stats`)).status, 404);
  assert.equal((await fetch(`${base}/stats/data.json`)).status, 404);
  assert.equal((await fetch(`${base}/stats/login`, { method: "POST" })).status, 404);
  await close();
  const short = await start({ statsToken: "too-short" });
  assert.equal((await fetch(`${short.base}/stats`)).status, 404);
  await short.close();
});

test("/healthz: 200 when healthy, 503 when not", async () => {
  const { base, close } = await start();
  const ok = await fetch(`${base}/healthz`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  await close();
  const down = await start({ unhealthy: true });
  const bad = await fetch(`${down.base}/healthz`);
  assert.equal(bad.status, 503);
  assert.deepEqual(await bad.json(), { ok: false });
  await down.close();
});
