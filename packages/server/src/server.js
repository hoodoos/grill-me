// The Grill Me server: encrypted grills in SQLite, a long poll for answers, and the static
// page. It stores only ciphertext; the key never reaches it (it lives in the link's #fragment).
//
// Metrics: daily counters and bucket counters only — never content, IPs, ids, link parts or
// user agents verbatim, and never one row per grill.
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isId, b64urlDecode, b64urlEncode, hashWriteToken, LIMITS } from "../../core/src/index.js";
import { wantsMarkdown, loadInstall } from "./install.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SRC, "..", "public");
const STATS_DIR = path.join(SRC, "..", "stats-page");
const UI_DIR = path.join(SRC, "..", "..", "ui", "src");
const CORE_DIR = path.join(SRC, "..", "..", "core", "src");
const PKG_VERSION = JSON.parse(
  await readFile(path.join(SRC, "..", "package.json"), "utf8"),
).version || "0.0.0";

const BODY_CAP = 32768; // request bodies over 32 KB are refused without being read
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// ---------- metrics vocabulary ----------
const AGENTS = ["claude-code", "codex", "cursor", "gemini-cli", "vscode", "claude-ai", "chatgpt", "claude-desktop", "other"];
const QB_BUCKETS = new Set(["1", "2-3", "4-6", "7-10", "11-20", "21-30"]);
const TIME_BUCKETS = [[60, "<1m"], [300, "1-5m"], [900, "5-15m"], [1800, "15-30m"], [3600, "30-60m"], [Infinity, ">60m"]];
const SIZE_BUCKETS = [[1024, "<1k"], [2048, "1-2k"], [5120, "2-5k"], [10240, "5-10k"], [Infinity, "10-20k"]];
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_VERSIONS_PER_DAY = 20;
const KEEP_DAYS = 400;

// Maps an MCP clientInfo.name (hosted mode, a later milestone) onto the agent allowlist.
export function mapAgentName(name) {
  const n = String(name ?? "").toLowerCase();
  if (AGENTS.includes(n)) return n;
  if (n.includes("visual studio code")) return "vscode";
  for (const a of AGENTS) if (a !== "other" && (n.includes(a) || n.includes(a.replace(/-/g, " ")))) return a;
  return "unknown";
}

const timeBucket = (ms) => TIME_BUCKETS.find(([max]) => ms < max * 1000)[1];
const sizeBucket = (bytes) => SIZE_BUCKETS.find(([max]) => bytes < max)[1];

// User-Agent: grill-me-ai/<version> (<agent>)
function parseUA(ua) {
  const m = /^grill-me-ai\/(\S+)\s*(?:\(([^)]*)\))?$/.exec(String(ua ?? "").trim());
  return { version: m && VERSION_RE.test(m[1]) ? m[1] : "other", agent: m && m[2] ? mapAgentName(m[2]) : "unknown" };
}

export function createServer(options = {}) {
  const {
    db = ":memory:",
    now = Date.now,
    ttlMs = 3_600_000,
    sweepMs = 60_000,
    maxWaitS = 50,
    log = () => {},
    createsPerHour = 60,
    waitersPerGrill = 3,
    waitersPerIp = 200,
    statsToken = process.env.STATS_TOKEN || "",
    memoryMaxBytes = process.env.MEMORY_MAX_BYTES ? Number(process.env.MEMORY_MAX_BYTES) : null,
    version = process.env.GRILL_ME_VERSION || null,
    unhealthy = false, // test seam: force /healthz to report 503
  } = options;
  const statsOn = typeof statsToken === "string" && statsToken.length >= 32;
  const startedAt = now();
  let shuttingDown = false;

  // ---------- storage ----------
  const dbh = new DatabaseSync(db);
  dbh.exec("PRAGMA journal_mode=WAL");
  dbh.exec("PRAGMA cache_size=-2000"); // ~2 MB page cache: the production box is tiny
  dbh.exec(`CREATE TABLE IF NOT EXISTS grills(
    id TEXT PRIMARY KEY, ct TEXT NOT NULL, iv TEXT NOT NULL, write_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, opened_at INTEGER, ans_ct TEXT, ans_iv TEXT)`);
  dbh.exec(`CREATE TABLE IF NOT EXISTS stats(
    day TEXT NOT NULL, name TEXT NOT NULL, bucket TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL,
    PRIMARY KEY (day, name, bucket))`);
  const qGet = dbh.prepare("SELECT * FROM grills WHERE id = ?");
  const qInsert = dbh.prepare("INSERT INTO grills(id, ct, iv, write_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  const qOpened = dbh.prepare("UPDATE grills SET opened_at = ? WHERE id = ? AND opened_at IS NULL");
  const qAnswer = dbh.prepare("UPDATE grills SET ans_ct = ?, ans_iv = ?, expires_at = ? WHERE id = ?");
  const qDelete = dbh.prepare("DELETE FROM grills WHERE id = ?");
  const qExpired = dbh.prepare("SELECT id, ans_ct FROM grills WHERE expires_at <= ?");
  const qStat = dbh.prepare(`INSERT INTO stats(day, name, bucket, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(day, name, bucket) DO UPDATE SET count = count + 1`);
  const qPruneStats = dbh.prepare("DELETE FROM stats WHERE day < ?");
  const qVersions = dbh.prepare("SELECT COUNT(DISTINCT bucket) AS n FROM stats WHERE day = ? AND name = 'cli_version'");
  const qHasVersion = dbh.prepare("SELECT 1 FROM stats WHERE day = ? AND name = 'cli_version' AND bucket = ?");

  const day = () => new Date(now()).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const stat = (name, bucket = "") => qStat.run(day(), name, bucket);

  // Agent/version/question-count signals come in at create time and are never stored with the grill.
  const statCreate = (req, ctBytes, qb) => {
    stat("created");
    stat("grill_size", sizeBucket(ctBytes));
    if (QB_BUCKETS.has(qb)) stat("questions", qb);
    const { version: v, agent } = parseUA(req.headers["user-agent"]);
    stat("agent", agent);
    if (v !== "other" && !qHasVersion.get(day(), v) && qVersions.get(day()).n >= MAX_VERSIONS_PER_DAY) stat("cli_version", "other");
    else stat("cli_version", v);
  };

  const liveRow = (id) => {
    const row = qGet.get(id);
    return row && row.expires_at > now() ? row : null; // a row past expires_at is already a 404
  };

  // ---------- in-memory limits and live counters (never written to disk or logs) ----------
  const creates = new Map(); // ip -> timestamps within the rolling hour
  const waiters = new Map(); // grill id -> Set of { res, timer, ip }
  const waitersByIp = new Map(); // ip -> count
  const logins = new Map(); // ip -> timestamps within the minute (stats login attempts)
  const minutes = new Map(); // minute epoch -> { requests, errors5xx, errors429 }
  const capMap = (map, max) => {
    if (map.size <= max) return;
    for (const k of map.keys()) { map.delete(k); if (map.size <= max) break; }
  };
  const createAllowed = (ip) => {
    const since = now() - 3_600_000;
    const list = (creates.get(ip) || []).filter((t) => t > since);
    if (list.length >= createsPerHour) { creates.set(ip, list); return false; }
    list.push(now());
    creates.set(ip, list);
    capMap(creates, 10_000);
    return true;
  };
  const loginAllowed = (ip) => {
    const since = now() - 60_000;
    const list = (logins.get(ip) || []).filter((t) => t > since);
    if (list.length >= 5) { logins.set(ip, list); return false; }
    list.push(now());
    logins.set(ip, list);
    capMap(logins, 10_000);
    return true;
  };
  const recordMinute = (status) => {
    const m = Math.floor(now() / 60_000);
    let c = minutes.get(m);
    if (!c) {
      c = { requests: 0, errors5xx: 0, errors429: 0 };
      minutes.set(m, c);
      for (const k of [...minutes.keys()].sort((a, b) => a - b).slice(0, -20)) minutes.delete(k); // keep ~20 min
    }
    c.requests++;
    if (status >= 500) c.errors5xx++;
    if (status === 429) c.errors429++;
  };

  const wake = (id, status, body) => {
    const set = waiters.get(id);
    if (!set) return;
    waiters.delete(id);
    for (const w of set) {
      clearTimeout(w.timer);
      w.done = true;
      waitersByIp.set(w.ip, (waitersByIp.get(w.ip) || 1) - 1);
      body ? sendJson(w.res, status, body) : sendEmpty(w.res, status);
    }
  };
  const dropWaiter = (id, w) => {
    const set = waiters.get(id);
    if (!set || !set.delete(w)) return;
    if (!set.size) waiters.delete(id);
    if (!w.done) { clearTimeout(w.timer); waitersByIp.set(w.ip, (waitersByIp.get(w.ip) || 1) - 1); }
  };

  // The sweeper: expired rows are deleted (counted by whether they had answers), their waiters
  // get 404, and stats days older than 400 are pruned.
  const sweep = () => {
    for (const { id, ans_ct } of qExpired.all(now())) {
      if (qDelete.run(id).changes) {
        stat(ans_ct === null ? "expired_unanswered" : "expired_answered");
        wake(id, 404, { error: "gone" });
      }
    }
    const cutoff = new Date(now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    qPruneStats.run(cutoff);
  };
  const sweeper = setInterval(sweep, sweepMs);
  sweeper.unref();

  // ---------- helpers ----------
  const clientIp = (req) => {
    const ra = req.socket.remoteAddress || "";
    const loopback = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
    if (loopback) {
      const real = req.headers["x-real-ip"];
      if (typeof real === "string" && real.trim()) return real.trim();
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string") {
        const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1]; // the entry nearest to us
      }
    }
    return ra;
  };

  const send = (res, status, headers, body) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.writeHead(status, headers);
    res.end(body);
  };
  const sendJson = (res, status, obj) =>
    send(res, status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify(obj));
  const sendEmpty = (res, status) => send(res, status, { "cache-control": "no-store" });
  const badRequest = (res, error) => sendJson(res, 400, { error });

  // ---------- install guide (milestone 2, phase 3): one render at startup ----------
  // The guide's CSP overrides the default via writeHead (its headers win over setHeader).
  const install = loadInstall(path.join(PUBLIC_DIR, "index.html"));
  const GUIDE_HEADERS = {
    "content-type": "text/plain; charset=utf-8",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "cache-control": "public, max-age=300",
  };
  const sendText = (req, res, text, vary) => {
    const headers = vary ? { ...GUIDE_HEADERS, vary: "Accept, User-Agent" } : GUIDE_HEADERS;
    send(res, 200, headers, req.method === "HEAD" ? undefined : text);
  };
  const serveHomepage = (req, res) =>
    send(res, 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      vary: "Accept, User-Agent",
    }, req.method === "HEAD" ? undefined : install.homepage);

  const decLen = (s) => {
    try { return typeof s === "string" ? b64urlDecode(s).length : -1; } catch { return -1; }
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const tooBig = () => Object.assign(new Error("body too large"), { status: 413 });
      const len = Number(req.headers["content-length"] || 0);
      if (len > BODY_CAP) { req.resume(); return reject(tooBig()); }
      const chunks = [];
      let size = 0, over = false;
      req.on("data", (c) => {
        size += c.length;
        // Over the cap mid-stream: stop buffering but keep draining, so the client gets a
        // clean 413 instead of a socket reset.
        if (size > BODY_CAP) { over = true; chunks.length = 0; }
        else if (!over) chunks.push(c);
      });
      req.on("end", () => (over ? reject(tooBig()) : resolve(Buffer.concat(chunks))));
      req.on("error", reject);
    });

  const readJson = async (req) => {
    const buf = await readBody(req);
    try { return { value: JSON.parse(buf.toString("utf8")) }; }
    catch { return { error: "expected a JSON object" }; }
  };

  const tokenEq = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  // Bearer writeToken: missing or malformed → 401; wrong → 403 (timing-safe compare).
  const auth = async (req, row) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
    if (!m) return 401;
    const hash = await hashWriteToken(m[1]);
    if (!hash) return 401;
    return tokenEq(hash, row.write_hash) ? 0 : 403;
  };

  // ---------- /stats auth ----------
  const statsCookie = () =>
    b64urlEncode(crypto.createHmac("sha256", statsToken).update("grill-me/stats-cookie/v1").digest());
  const statsAuthed = (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
    if (m && tokenEq(m[1], statsToken)) return true;
    const cookie = /(?:^|;\s*)gm_stats=([^;\s]+)/.exec(req.headers.cookie || "");
    return !!cookie && tokenEq(cookie[1], statsCookie());
  };
  const STATS_HEADERS = { "x-robots-tag": "noindex", "cache-control": "no-store" };
  const sendStats = (res, status, headers, body) =>
    send(res, status, { ...STATS_HEADERS, ...headers }, body);

  // ---------- static files ----------
  const serveFile = async (req, res, file, extraHeaders = {}) => {
    let data;
    try { data = await readFile(file); }
    catch { return sendEmpty(res, 404); }
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) return sendEmpty(res, 404);
    const headers = { "content-type": type, "cache-control": "public, max-age=300", ...extraHeaders };
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    res.end(data);
  };
  const under = (root, rel) => {
    const file = path.resolve(root, rel);
    return file.startsWith(root + path.sep) ? file : null; // path traversal stays impossible
  };
  const serveStatic = (req, res, pathname) => {
    if (req.method !== "GET" && req.method !== "HEAD") return sendEmpty(res, 405);
    let file = null;
    if (pathname === "/") file = path.join(PUBLIC_DIR, "index.html");
    else if (pathname === "/demo" || pathname === "/hub" || pathname === "/robots.txt")
      file = path.join(PUBLIC_DIR, pathname === "/demo" ? "grill.html" : pathname === "/hub" ? "hub.html" : "robots.txt");
    else if (pathname.startsWith("/g/")) {
      const id = pathname.slice(3);
      if (!isId(id)) return sendEmpty(res, 404);
      file = path.join(PUBLIC_DIR, "grill.html");
    } else if (pathname.startsWith("/ui/")) file = under(UI_DIR, pathname.slice(4));
    else if (pathname.startsWith("/core/")) file = under(CORE_DIR, pathname.slice(6));
    else file = under(PUBLIC_DIR, pathname.slice(1));
    if (!file || !MIME[path.extname(file).toLowerCase()]) return sendEmpty(res, 404);
    return serveFile(req, res, file);
  };

  // ---------- /stats ----------
  const statsData = () => {
    const since = new Date(now() - 30 * 86400000).toISOString().slice(0, 10);
    const days = dbh.prepare("SELECT day, name, bucket, count FROM stats WHERE day >= ? ORDER BY day, name, bucket").all(since);
    let waitersMax = 0, waitersTotal = 0;
    for (const set of waiters.values()) { waitersTotal += set.size; waitersMax = Math.max(waitersMax, set.size); }
    const minuteNow = Math.floor(now() / 60_000);
    const minutesOut = [];
    for (let m = minuteNow - 14; m <= minuteNow; m++) {
      const c = minutes.get(m);
      minutesOut.push({ minute: m * 60_000, requests: c?.requests || 0, errors5xx: c?.errors5xx || 0, errors429: c?.errors429 || 0 });
    }
    let maxBytes = memoryMaxBytes;
    if (maxBytes == null) {
      try {
        const v = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
        if (v !== "max") maxBytes = Number(v);
      } catch {}
    }
    const mem = process.memoryUsage();
    const dbBytes = dbh.prepare("PRAGMA page_count").get().page_count * dbh.prepare("PRAGMA page_size").get().page_size;
    return {
      generatedAt: now(),
      version: { package: PKG_VERSION, deploy: version },
      uptimeS: Math.floor((now() - startedAt) / 1000),
      dbBytes,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        maxBytes: maxBytes ?? null,
        pct: maxBytes ? Math.round((mem.rss / maxBytes) * 1000) / 10 : null,
      },
      live: { waiters: waitersTotal, waitersMaxPerGrill: waitersMax, minutes: minutesOut },
      days,
    };
  };

  const statsRoute = async (req, res, pathname) => {
    if (!statsOn) return sendEmpty(res, 404);
    if (req.method === "POST" && pathname === "/stats/login") {
      if (!loginAllowed(clientIp(req))) return sendStats(res, 429, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: "too many attempts" }));
      const body = await readJson(req);
      if (body.error) return sendStats(res, 400, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: body.error }));
      if (!tokenEq(body.value?.token ?? "", statsToken))
        return sendStats(res, 401, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: "wrong token" }));
      return sendStats(res, 204, {
        "set-cookie": `gm_stats=${statsCookie()}; HttpOnly; Secure; SameSite=Strict; Path=/stats; Max-Age=2592000`,
      });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return sendStats(res, 405, {});
    if (!statsAuthed(req)) {
      if (pathname === "/stats" || pathname === "/stats/")
        return serveFile(req, res, path.join(STATS_DIR, "login.html"), STATS_HEADERS);
      if (pathname === "/stats/login.js" || pathname === "/stats/login.css")
        return serveFile(req, res, path.join(STATS_DIR, pathname.slice(7)), STATS_HEADERS);
      return sendStats(res, 401, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: "unauthorized" }));
    }
    if (pathname === "/stats" || pathname === "/stats/")
      return serveFile(req, res, path.join(STATS_DIR, "stats.html"), STATS_HEADERS);
    if (pathname === "/stats/data.json")
      return sendStats(res, 200, { "content-type": "application/json; charset=utf-8" }, JSON.stringify(statsData()));
    if (pathname === "/stats/stats.js" || pathname === "/stats/stats.css")
      return serveFile(req, res, path.join(STATS_DIR, pathname.slice(7)), STATS_HEADERS);
    return sendStats(res, 404, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: "not found" }));
  };

  // ---------- routes ----------
  const postGrill = async (req, res) => {
    const ip = clientIp(req);
    if (!createAllowed(ip)) { req.resume(); return sendJson(res, 429, { error: "too many grills" }); }
    const body = await readJson(req);
    if (body.error) return badRequest(res, body.error);
    const { id, ct, iv, writeHash, qb } = body.value ?? {};
    if (!isId(id)) return badRequest(res, "id: must be 16 base64url characters");
    if (decLen(iv) !== 12) return badRequest(res, "iv: must decode to 12 bytes");
    if (decLen(writeHash) !== 32) return badRequest(res, "writeHash: must decode to 32 bytes");
    const ctLen = decLen(ct);
    if (ctLen < 17 || ctLen > LIMITS.grillBytes) return badRequest(res, `ct: must decode to 17..${LIMITS.grillBytes} bytes`);
    const t = now();
    const expiresAt = t + ttlMs;
    try { qInsert.run(id, ct, iv, writeHash, t, expiresAt); }
    catch { return sendJson(res, 409, { error: "id taken" }); }
    statCreate(req, ctLen, qb);
    sendJson(res, 201, { id, expiresAt });
  };

  const getGrill = (res, id) => {
    if (!isId(id)) return sendEmpty(res, 404);
    const row = liveRow(id);
    if (!row) return sendEmpty(res, 404);
    if (row.opened_at === null && qOpened.run(now(), id).changes) {
      stat("opened");
      stat("time_to_open", timeBucket(now() - row.created_at));
    }
    sendJson(res, 200, { ct: row.ct, iv: row.iv, answered: row.ans_ct !== null, expiresAt: row.expires_at });
  };

  const postAnswers = async (req, res, id) => {
    if (!isId(id)) return sendEmpty(res, 404);
    const body = await readJson(req);
    if (body.error) return badRequest(res, body.error);
    const { ct, iv } = body.value ?? {};
    if (decLen(iv) !== 12) return badRequest(res, "iv: must decode to 12 bytes");
    const ctLen = decLen(ct);
    if (ctLen < 17 || ctLen > LIMITS.answersBytes) return badRequest(res, `ct: must decode to 17..${LIMITS.answersBytes} bytes`);
    const row = liveRow(id);
    if (!row) return sendEmpty(res, 404);
    const authRes = await auth(req, row);
    if (authRes === 401) return sendJson(res, 401, { error: "missing or malformed Authorization header" });
    if (authRes === 403) return sendJson(res, 403, { error: "wrong write token" });
    if (row.ans_ct !== null) return sendJson(res, 409, { error: "already answered" });
    // Answered grills live ttlMs past the answer, so an answer at minute 59 isn't lost.
    qAnswer.run(ct, iv, now() + ttlMs, id);
    stat("answered");
    stat("time_to_answer", timeBucket(now() - row.created_at));
    wake(id, 200, { ct, iv });
    sendEmpty(res, 204);
  };

  const getAnswers = (req, res, id, url) => {
    if (!isId(id)) return sendEmpty(res, 404);
    const row = liveRow(id);
    if (!row) return sendEmpty(res, 404);
    if (row.ans_ct !== null) return sendJson(res, 200, { ct: row.ans_ct, iv: row.ans_iv });
    const raw = Number(url.searchParams.get("wait") || 0);
    const waitS = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), maxWaitS) : 0;
    if (!waitS) return sendEmpty(res, 204);
    const ip = clientIp(req);
    const set = waiters.get(id);
    if ((set?.size || 0) >= waitersPerGrill || (waitersByIp.get(ip) || 0) >= waitersPerIp)
      return sendJson(res, 429, { error: "too many waiting requests" });
    const w = { res, ip, done: false };
    w.timer = setTimeout(() => { dropWaiter(id, w); w.done = true; sendEmpty(res, 204); }, waitS * 1000);
    w.timer.unref();
    res.on("close", () => dropWaiter(id, w));
    if (!waiters.has(id)) waiters.set(id, new Set());
    waiters.get(id).add(w);
    waitersByIp.set(ip, (waitersByIp.get(ip) || 0) + 1);
    capMap(waitersByIp, 10_000);
  };

  const deleteGrill = async (req, res, id) => {
    if (!isId(id)) return sendEmpty(res, 404);
    const row = liveRow(id);
    if (!row) return sendEmpty(res, 404);
    const authRes = await auth(req, row);
    if (authRes === 401) return sendJson(res, 401, { error: "missing or malformed Authorization header" });
    if (authRes === 403) return sendJson(res, 403, { error: "wrong write token" });
    qDelete.run(id);
    stat(row.ans_ct === null ? "cancelled" : "picked_up");
    wake(id, 404, { error: "gone" });
    sendEmpty(res, 204);
  };

  const server = http.createServer(async (req, res) => {
    const t0 = now();
    res.on("close", () => {
      const u = new URL(req.url, "http://x");
      log(`${new Date(now()).toISOString()} ${req.method} ${u.pathname} ${res.statusCode} ${now() - t0}ms`);
      recordMinute(res.statusCode);
    });
    try {
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      if (p === "/healthz") {
        let ok = !shuttingDown && !unhealthy;
        if (ok) try { dbh.prepare("SELECT 1").get(); } catch { ok = false; }
        return sendJson(res, ok ? 200 : 503, { ok });
      }
      if (p === "/go/hub") {
        stat("hub_click");
        return send(res, 302, { location: "/hub", "cache-control": "no-store" });
      }
      if (p === "/stats" || p.startsWith("/stats/")) return await statsRoute(req, res, p);
      if (p === "/api/g" && req.method === "POST") return await postGrill(req, res);
      const m = /^\/api\/g\/([^/]+)(\/answers)?$/.exec(p);
      if (m) {
        const [, id, answers] = m;
        if (!answers) {
          if (req.method === "GET") return getGrill(res, id);
          if (req.method === "DELETE") return await deleteGrill(req, res, id);
        } else {
          if (req.method === "POST") return await postAnswers(req, res, id);
          if (req.method === "GET") return getAnswers(req, res, id, url);
        }
        return sendEmpty(res, 405);
      }
      if (p.startsWith("/api/")) return sendEmpty(res, 404);
      // ---------- install routes (phase 3); nginx serves these from the static tree ----------
      if (p === "/install" || p === "/llms.txt" || p === "/") {
        if (req.method !== "GET" && req.method !== "HEAD") return sendEmpty(res, 405);
        if (p === "/install") return sendText(req, res, install.guide, false);
        if (p === "/llms.txt") return sendText(req, res, install.llms, false);
        return wantsMarkdown(req.headers.accept, req.headers["user-agent"])
          ? sendText(req, res, install.guide, true)
          : serveHomepage(req, res);
      }
      return await serveStatic(req, res, p);
    } catch (e) {
      if (e.status === 413) return sendJson(res, 413, { error: "body too large" });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    }
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 70_000;
  server.keepAliveTimeout = 65_000;

  const close = () =>
    new Promise((resolve, reject) => {
      shuttingDown = true;
      clearInterval(sweeper);
      for (const id of [...waiters.keys()]) wake(id, 204); // shutdown answers every waiter 204
      server.close((err) => {
        try { dbh.close(); } catch {}
        err ? reject(err) : resolve();
      });
      server.closeIdleConnections(); // drop keep-alive sockets now, don't wait out keepAliveTimeout
    });

  return { server, close };
}
