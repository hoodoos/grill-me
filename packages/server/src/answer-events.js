// Durable callback metadata ONLY. No question/answer/link/key/design-tree persistence.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { callbackPost, callbackUrl, signingKey, signWebhook, safeEqual, CallbackError } from "./callback-transport.js";

export const EVENT_NAME = "grill.answers_ready";
const HOUR = 3_600_000, ROTATION = 300_000;
const BACKOFF = [1000, 5000, 15_000, 60_000, 180_000, 600_000, 900_000];
const random = () => crypto.randomBytes(18).toString("base64url");
const object = v => v && typeof v === "object" && !Array.isArray(v);
const invalid = () => { throw new CallbackError("invalid_subscription"); };
const checkpoint = v => object(v) && Object.keys(v).sort().join() === "reference,revision" &&
  typeof v.reference === "string" && v.reference.length > 0 && v.reference.length <= 512 &&
  typeof v.revision === "string" && v.revision.length > 0 && v.revision.length <= 256;

function sealingKey(db, keyFile, hasSubscriptions) {
  if (db === ":memory:") return crypto.randomBytes(32);
  const filename = keyFile ?? path.join(path.dirname(path.resolve(db)), "callback-sealing.key");
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filename)) {
    if (hasSubscriptions) throw new Error("Callback sealing key missing; restore the original private key");
    let fd; const temp = filename + "." + crypto.randomUUID() + ".tmp";
    try {
      fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, crypto.randomBytes(32)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.linkSync(temp, filename); // atomic complete-file publication, no overwrite on a race
    }
    catch (e) { if (e.code !== "EEXIST") throw new Error("Cannot create callback sealing key"); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
  const st = fs.lstatSync(filename);
  if (!st.isFile() || st.isSymbolicLink() || process.platform !== "win32" && (st.mode & 0o777) !== 0o600) throw new Error("Callback sealing key must be a private regular0600 file");
  const key = fs.readFileSync(filename);
  if (key.length !== 32) throw new Error("Invalid callback sealing key");
  return key;
}

export function createAnswerEvents({ dbh, db, now, stat, options = {} }) {
  dbh.exec(`CREATE TABLE IF NOT EXISTS event_subscriptions(
    session_id TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL,
    provider TEXT NOT NULL, config TEXT NOT NULL, expires_at INTEGER NOT NULL,
    prepared_until INTEGER NOT NULL, bound INTEGER NOT NULL, verified_until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS event_outbox(
    event_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, session_id TEXT NOT NULL,
    round INTEGER NOT NULL, revision INTEGER NOT NULL, submission_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT0,
    next_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT0, lease_token TEXT,
    state TEXT NOT NULL DEFAULT 'pending', UNIQUE(subscription_id,round));
    CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox(state,next_at,lease_until);`.replaceAll("DEFAULT0", "DEFAULT 0"));
  const get = dbh.prepare("SELECT * FROM event_subscriptions WHERE session_id = ?");
  const getId = dbh.prepare("SELECT * FROM event_subscriptions WHERE id = ?");
  const count = dbh.prepare("SELECT COUNT(*) AS n FROM event_subscriptions");
  const session = dbh.prepare("SELECT * FROM sessions WHERE id = ?");
  const terminal = dbh.prepare("SELECT 1 FROM session_terminals WHERE id = ? AND expires_at > ?");
  const key = sealingKey(db, options.keyFile, count.get().n > 0);
  const seal = (id, data) => {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`grill-me/callback-config/v1:${id}`));
    return Buffer.concat([iv, cipher.update(JSON.stringify(data), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
  };
  const open = row => {
    const data = Buffer.from(row.config, "base64"), cipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(`grill-me/callback-config/v1:${row.id}`)); cipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString("utf8"));
  };
  // Fail startup rather than silently dropping an unreadable callback after a bad restore.
  for (const row of dbh.prepare("SELECT * FROM event_subscriptions").all()) open(row);
  const remove = id => { dbh.prepare("DELETE FROM event_outbox WHERE session_id = ?").run(id); dbh.prepare("DELETE FROM event_subscriptions WHERE session_id = ?").run(id); };
  const transaction = fn => { dbh.exec("BEGIN IMMEDIATE"); try { const value = fn(); dbh.exec("COMMIT"); return value; } catch (e) { dbh.exec("ROLLBACK"); throw e; } };
  const prune = () => {
    dbh.prepare(`DELETE FROM event_subscriptions WHERE expires_at <= ? OR
      (bound = 0 AND prepared_until <= ? AND NOT EXISTS(SELECT 1 FROM sessions WHERE sessions.id=event_subscriptions.session_id AND sessions.expires_at>?)) OR
      (bound = 1 AND NOT EXISTS(SELECT 1 FROM sessions WHERE sessions.id=event_subscriptions.session_id AND sessions.expires_at>?))`)
      .run(now(), now(), now(), now());
    dbh.prepare("DELETE FROM event_outbox WHERE expires_at <= ? OR NOT EXISTS(SELECT 1 FROM event_subscriptions WHERE id=event_outbox.subscription_id)").run(now());
  };
  const authorize = (id, authHash, preparedUntil) => {
    const row = session.get(id);
    if (row) {
      if (row.expires_at <= now() || !safeEqual(row.write_hash, authHash)) invalid();
    } else if (terminal.get(id, now()) || !Number.isSafeInteger(preparedUntil) || preparedUntil <= now() || preparedUntil > now() + 601_000) invalid();
    return row;
  };
  const enqueue = row => {
    if (!row || row.state !== "answered" || row.expires_at <= now()) return;
    const sub = get.get(row.id);
    if (!sub || sub.expires_at <= now() || !safeEqual(sub.auth_hash, row.write_hash)) return;
    const eventId = "evt_" + crypto.createHmac("sha256", key).update(JSON.stringify([sub.id, row.id, row.round, row.revision, row.sub_id])).digest("base64url").slice(0, 32);
    dbh.prepare(`INSERT OR IGNORE INTO event_outbox(event_id,subscription_id,session_id,round,revision,submission_id,occurred_at,expires_at,next_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(eventId, sub.id, row.id, row.round, row.revision, row.sub_id, now(), Math.min(sub.expires_at, row.expires_at), now());
  };
  const bind = row => {
    const prepared = get.get(row.id);
    // The real first create establishes authority: an unrelated guessed-id preparation
    // cannot reserve this owner's subscription namespace with a different capability.
    if (prepared && !safeEqual(prepared.auth_hash, row.write_hash)) remove(row.id);
    dbh.prepare("UPDATE event_subscriptions SET bound=1 WHERE session_id=? AND auth_hash=?").run(row.id, row.write_hash);
  };
  const limits = { subscriptions: options.subscriptions ?? 1000, concurrent: options.concurrent ?? 4, registrations: options.registrations ?? 300 };
  const registrations = new Map(), controllers = new Set(), intents = new Map(); let active = 0, closed = false;
  const rate = id => {
    const cutoff = now() - HOUR;
    for (const [k, timestamps] of registrations) { const live = timestamps.filter(t => t > cutoff); live.length ? registrations.set(k, live) : registrations.delete(k); }
    const total = [...registrations.values()].reduce((n, a) => n + a.length, 0), own = registrations.get(id) ?? [];
    if (total >= limits.registrations || own.length >= 10) throw new CallbackError("capacity");
    registrations.set(id, [...own, now()]);
  };
  const post = async (config, id, eventId, body, signal) => {
    if (active >= limits.concurrent) throw new CallbackError("capacity");
    active++;
    try {
      const timestamp = String(Math.floor(now() / 1000));
      const signatures = [signWebhook(config.secret, eventId, timestamp, body)];
      if (config.oldSecret && config.rotateUntil > now()) signatures.push(signWebhook(config.oldSecret, eventId, timestamp, body));
      return await (options.post ?? callbackPost)(config.url, { body, headers: {
        "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signatures.join(" "), "X-MCP-Subscription-Id": id,
      }, signal, timeoutMs: 10_000 });
    } finally { active--; }
  };
  async function subscribe({ sessionId, authHash, preparedUntil, provider = "chatgpt", delivery, ttlMs, contextReference, signal }) {
    if (closed || !object(delivery) || delivery.mode !== "webhook" || !["chatgpt", "grok"].includes(provider)) invalid();
    const url = callbackUrl(delivery.url).href; signingKey(delivery.secret);
    if (ttlMs !== undefined && ttlMs !== null && (!Number.isSafeInteger(ttlMs) || ttlMs < 1)) invalid();
    if (provider === "grok" && (typeof contextReference !== "string" || !contextReference || contextReference.length > 512)) invalid();
    prune(); authorize(sessionId, authHash, preparedUntil); rate(sessionId);
    const before = get.get(sessionId), old = before && safeEqual(before.auth_hash, authHash) ? open(before) : null;
    const id = "sub_" + crypto.createHmac("sha256", key).update(JSON.stringify([authHash, sessionId, EVENT_NAME, url, provider])).digest("base64url").slice(0, 32);
    if (before && before.id !== id) throw new CallbackError("conflict");
    if (!before && count.get().n >= limits.subscriptions) throw new CallbackError("capacity");
    const config = { url, secret: delivery.secret, ...(provider === "grok" ? { contextReference, contextRevision: old?.contextReference === contextReference ? old.contextRevision : null, lastAck: old?.contextReference === contextReference ? old.lastAck : null } : {}) };
    const intentKey = sessionId + ":" + authHash, nonce = random(); intents.set(intentKey, nonce);
    let verifiedUntil = before?.verified_until ?? 0;
    try {
    if (provider === "chatgpt" && !(old?.secret === config.secret && verifiedUntil > now())) {
      const challenge = random(), response = await post(config, id, "msg_verification_" + random(), JSON.stringify({ type: "verification", challenge }), signal);
      let echoed; try { echoed = JSON.parse(response.body).challenge; } catch {}
      if (response.status < 200 || response.status >= 300 || !safeEqual(challenge, echoed)) throw new CallbackError("challenge_failed");
      verifiedUntil = now() + ROTATION;
    }
    if (signal?.aborted) throw new CallbackError("timeout");
    if (intents.get(intentKey) !== nonce) throw new CallbackError("conflict");
    const expires = now() + Math.min(ttlMs ?? HOUR, HOUR);
    transaction(() => {
      const row = authorize(sessionId, authHash, preparedUntil), current = get.get(sessionId);
      // A concurrent registration/unsubscribe cannot be overwritten after the challenge.
      if (current?.config !== before?.config || current?.id !== before?.id) throw new CallbackError("conflict");
      if (!current && count.get().n >= limits.subscriptions) throw new CallbackError("capacity");
      if (old && old.secret !== config.secret) { config.oldSecret = old.secret; config.rotateUntil = now() + ROTATION; }
      else if (old?.oldSecret && old.rotateUntil > now()) { config.oldSecret = old.oldSecret; config.rotateUntil = old.rotateUntil; }
      dbh.prepare(`INSERT INTO event_subscriptions(session_id,id,auth_hash,provider,config,expires_at,prepared_until,bound,verified_until)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET config=excluded.config,expires_at=excluded.expires_at,bound=excluded.bound,verified_until=excluded.verified_until`)
        .run(sessionId, id, authHash, provider, seal(id, config), expires, preparedUntil, row ? 1 : 0, verifiedUntil);
      dbh.prepare("UPDATE event_outbox SET expires_at=MIN(?,?) WHERE subscription_id=?").run(expires, row?.expires_at ?? expires, id);
      enqueue(row);
    });
    kick();
    return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false,
      ...(provider === "grok" ? { callbackVerification: "not_supported", contextContinuity: "host_checkpoint_required_not_verified" } : {}) };
    } finally { if (intents.get(intentKey) === nonce) intents.delete(intentKey); }
  }
  function unsubscribe({ sessionId, authHash, preparedUntil, delivery }) {
    const url = callbackUrl(delivery?.url).href;
    const row = get.get(sessionId);
    // Exact authorized unsubscribe remains safe after terminal/pruning: no fetched URL.
    if (row && (!safeEqual(row.auth_hash, authHash) || open(row).url !== url)) invalid();
    intents.delete(sessionId + ":" + authHash); // only this capability's challenge in flight
    if (!row) return {};
    authorize(sessionId, authHash, preparedUntil); remove(sessionId); return {};
  }
  function ackCheck(row, receipt, contextReceipt, replay = false) {
    const sub = get.get(row.id);
    if (!sub || sub.provider !== "grok" || sub.expires_at <= now()) return null;
    const config = open(sub);
    if (!checkpoint(contextReceipt) || contextReceipt.reference !== config.contextReference) throw new CallbackError("context_required");
    const digest = crypto.createHmac("sha256", key).update(JSON.stringify([receipt, contextReceipt])).digest("hex");
    if (replay ? config.lastAck !== digest : config.contextRevision === contextReceipt.revision) throw new CallbackError("context_required");
    return { sub, config, digest, contextReceipt };
  }
  const acknowledged = (row, checked) => {
    dbh.prepare("DELETE FROM event_outbox WHERE session_id=? AND round=?").run(row.id, row.round);
    if (checked) {
      const { sub, config, digest, contextReceipt } = checked;
      config.contextRevision = contextReceipt.revision; config.lastAck = digest;
      dbh.prepare("UPDATE event_subscriptions SET config=? WHERE id=?").run(seal(sub.id, config), sub.id);
    }
  };
  async function deliver(job, leaseToken) {
    const controller = new AbortController(); controllers.add(controller);
    try {
      const sub = getId.get(job.subscription_id), row = session.get(job.session_id);
      if (!sub || sub.expires_at <= now() || !row || row.expires_at <= now() || !safeEqual(row.write_hash, sub.auth_hash) || row.state !== "answered" || row.round !== job.round || row.sub_id !== job.submission_id) {
        dbh.prepare("DELETE FROM event_outbox WHERE event_id=? AND lease_token=?").run(job.event_id, leaseToken); return;
      }
      const config = open(sub), body = JSON.stringify({ eventId: job.event_id, name: EVENT_NAME, timestamp: new Date(job.occurred_at).toISOString(),
        data: { sessionId: job.session_id, round: job.round, revision: job.revision, submissionId: job.submission_id }, cursor: null });
      const result = await post(config, sub.id, job.event_id, body, controller.signal);
      if (result.status >= 200 && result.status < 300 || result.status === 410 || result.status === 413) {
        dbh.prepare("UPDATE event_outbox SET state=?,lease_until=0,lease_token=NULL WHERE event_id=? AND lease_token=?")
          .run(result.status >= 200 && result.status < 300 ? "delivered" : "stopped", job.event_id, leaseToken);
        stat("event_delivery", result.status >= 200 && result.status < 300 ? "accepted" : "stopped"); return;
      }
      throw new CallbackError("rejected");
    } catch {
      if (!closed) {
        const exhausted = job.attempts >= 8;
        dbh.prepare("UPDATE event_outbox SET state=?,next_at=?,lease_until=0,lease_token=NULL WHERE event_id=? AND lease_token=?")
          .run(exhausted ? "stopped" : "pending", now() + BACKOFF[Math.min(job.attempts - 1, BACKOFF.length - 1)], job.event_id, leaseToken);
        stat("event_delivery", exhausted ? "exhausted" : "retry");
      }
    } finally { controllers.delete(controller); }
  }
  function pump() {
    if (closed) return;
    prune();
    while (active < limits.concurrent) {
      const job = dbh.prepare("SELECT * FROM event_outbox WHERE state='pending' AND next_at<=? AND lease_until<=? ORDER BY next_at LIMIT 1").get(now(), now());
      if (!job) break;
      const token = random();
      const won = dbh.prepare("UPDATE event_outbox SET attempts=attempts+1,lease_until=?,lease_token=? WHERE event_id=? AND state='pending' AND lease_until<=?").run(now() + 15_000, token, job.event_id, now()).changes;
      if (!won) continue;
      // deliver reserves its network slot synchronously before its first await.
      void deliver({ ...job, attempts: job.attempts + 1 }, token);
    }
  }
  const kick = () => queueMicrotask(pump);
  const timer = setInterval(pump, options.tickMs ?? 1000); timer.unref();
  const close = async () => { closed = true; clearInterval(timer); for (const c of controllers) c.abort();
    // Drain asynchronous callbacks before the owning SQLite handle closes.
    while (controllers.size) await new Promise(r => setTimeout(r, 5)); };
  return { subscribe, unsubscribe, enqueue, bind, remove, prune, transaction, ackCheck, acknowledged, kick, close,
    stats: () => ({ subscriptions: count.get().n, outbox: dbh.prepare("SELECT COUNT(*) AS n FROM event_outbox").get().n, active }) };
}
