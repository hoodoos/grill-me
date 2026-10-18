// The Grill Me server: encrypted grills in SQLite, a long poll for answers, and the static
// page. It stores only ciphertext; the key never reaches it (it lives in the link's #fragment).
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isId, b64urlDecode, hashWriteToken, LIMITS } from "../../core/src/index.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SRC, "..", "public");
const UI_DIR = path.join(SRC, "..", "..", "ui", "src");
const CORE_DIR = path.join(SRC, "..", "..", "core", "src");

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
const STATS_NAMES = new Set(["created", "answered", "deleted", "expired"]);

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
  } = options;

  // ---------- storage ----------
  const dbh = new DatabaseSync(db);
  dbh.exec("PRAGMA journal_mode=WAL");
  dbh.exec("PRAGMA cache_size=-2000"); // ~2 MB page cache: the production box is tiny
  dbh.exec(`CREATE TABLE IF NOT EXISTS grills(
    id TEXT PRIMARY KEY, ct TEXT NOT NULL, iv TEXT NOT NULL, write_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ans_ct TEXT, ans_iv TEXT)`);
  dbh.exec(`CREATE TABLE IF NOT EXISTS stats(
    day TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, name))`);
  const qGet = dbh.prepare("SELECT * FROM grills WHERE id = ?");
  const qInsert = dbh.prepare("INSERT INTO grills(id, ct, iv, write_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  const qAnswer = dbh.prepare("UPDATE grills SET ans_ct = ?, ans_iv = ?, expires_at = ? WHERE id = ?");
  const qDelete = dbh.prepare("DELETE FROM grills WHERE id = ?");
  const qExpired = dbh.prepare("SELECT id FROM grills WHERE expires_at <= ?");
  const qStat = dbh.prepare(`INSERT INTO stats(day, name, count) VALUES (?, ?, 1)
    ON CONFLICT(day, name) DO UPDATE SET count = count + 1`);

  const day = () => new Date(now()).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const stat = (name) => qStat.run(day(), name);
  const liveRow = (id) => {
    const row = qGet.get(id);
    return row && row.expires_at > now() ? row : null; // a row past expires_at is already a 404
  };

  // ---------- in-memory limits (never written to disk or logs) ----------
  const creates = new Map(); // ip -> timestamps within the rolling hour
  const waiters = new Map(); // grill id -> Set of { res, timer, ip }
  const waitersByIp = new Map(); // ip -> count
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

  // The sweeper: expired rows are deleted (counted as expired) and their waiters get 404.
  const sweep = () => {
    for (const { id } of qExpired.all(now())) {
      if (qDelete.run(id).changes) {
        stat("expired");
        wake(id, 404, { error: "gone" });
      }
    }
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

  const decLen = (s) => {
    try { return typeof s === "string" ? b64urlDecode(s).length : -1; } catch { return -1; }
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const fail = (err) => { if (!req.destroyed) req.destroy(); reject(err); };
      const len = Number(req.headers["content-length"] || 0);
      if (len > BODY_CAP) { req.resume(); return reject(Object.assign(new Error("body too large"), { status: 413 })); }
      const chunks = [];
      let size = 0, settled = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > BODY_CAP && !settled) { settled = true; fail(Object.assign(new Error("body too large"), { status: 413 })); }
        else if (!settled) chunks.push(c);
      });
      req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
      req.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    });

  const readJson = async (req) => {
    const buf = await readBody(req);
    try { return { value: JSON.parse(buf.toString("utf8")) }; }
    catch { return { error: "expected a JSON object" }; }
  };

  // Bearer writeToken: missing or malformed → 401; wrong → 403 (timing-safe compare).
  const auth = async (req, row) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
    if (!m) return 401;
    const hash = await hashWriteToken(m[1]);
    if (!hash) return 401;
    const a = Buffer.from(hash), b = Buffer.from(row.write_hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? 0 : 403;
  };

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

  // ---------- routes ----------
  const postGrill = async (req, res) => {
    const ip = clientIp(req);
    if (!createAllowed(ip)) { req.resume(); return sendJson(res, 429, { error: "too many grills" }); }
    const body = await readJson(req);
    if (body.error) return badRequest(res, body.error);
    const { id, ct, iv, writeHash } = body.value ?? {};
    if (!isId(id)) return badRequest(res, "id: must be 16 base64url characters");
    if (decLen(iv) !== 12) return badRequest(res, "iv: must decode to 12 bytes");
    if (decLen(writeHash) !== 32) return badRequest(res, "writeHash: must decode to 32 bytes");
    const ctLen = decLen(ct);
    if (ctLen < 17 || ctLen > LIMITS.grillBytes) return badRequest(res, `ct: must decode to 17..${LIMITS.grillBytes} bytes`);
    const t = now();
    const expiresAt = t + ttlMs;
    try { qInsert.run(id, ct, iv, writeHash, t, expiresAt); }
    catch { return sendJson(res, 409, { error: "id taken" }); }
    stat("created");
    sendJson(res, 201, { id, expiresAt });
  };

  const getGrill = (res, id) => {
    if (!isId(id)) return sendEmpty(res, 404);
    const row = liveRow(id);
    if (!row) return sendEmpty(res, 404);
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
    stat("deleted");
    wake(id, 404, { error: "gone" });
    sendEmpty(res, 204);
  };

  const server = http.createServer(async (req, res) => {
    const t0 = now();
    res.on("close", () => {
      const u = new URL(req.url, "http://x");
      log(`${new Date(now()).toISOString()} ${req.method} ${u.pathname} ${res.statusCode} ${now() - t0}ms`);
    });
    try {
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
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
      clearInterval(sweeper);
      for (const id of [...waiters.keys()]) wake(id, 204); // shutdown answers every waiter 204
      server.close((err) => {
        try { dbh.close(); } catch {}
        err ? reject(err) : resolve();
      });
    });

  return { server, close };
}
