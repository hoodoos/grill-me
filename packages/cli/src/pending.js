// ~/.grill-me/pending/<id>.json — the local record of a sent grill: { v, id, secret, server, grill, createdAt, expiresAt }.
// Written atomically (temp file + rename) with mode 0600; files older than 3 days are pruned.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PRUNE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const pendingDir = (home) => path.join(home, "pending");
const pendingPath = (home, id) => path.join(pendingDir(home), `${id}.json`);
const writes = new Map();

export async function savePending(home, record) {
  const file = pendingPath(home, record.id);
  // Windows can reject replacing a destination while another rename/chmod still has it open.
  // Serialize this process's writes per record; unique temps also isolate separate processes.
  const writing = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(() => writePending(home, record));
  writes.set(file, writing);
  try { return await writing; }
  finally { if (writes.get(file) === writing) writes.delete(file); }
}

async function writePending(home, record) {
  const dir = pendingDir(home);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = pendingPath(home, record.id);
  const tmp = path.join(dir, `.${record.id}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(record, null, 2) + "\n");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
  } finally {
    try { await handle?.close(); }
    finally { await fs.rm(tmp, { force: true }); } // only this write's unique temporary file
  }
  try {
    await fs.chmod(file, 0o600); // rename may keep a pre-existing file's mode
  } catch {
    /* Windows */
  }
  return file;
}

export async function readPending(home, id) {
  try {
    const record = JSON.parse(await fs.readFile(pendingPath(home, id), "utf8"));
    return record && record.id === id ? record : null;
  } catch {
    return null;
  }
}

// Cross-process bakery lock: unique pid/nonce generations publish tickets, then wait
// for earlier contenders. Missing tickets mean choosing. Only ESRCH proves death.
// No shared pathname is unlinked, avoiding stale-reaper/new-owner ABA races.
const lockCheck = (signal, ready) => {
  if (signal?.aborted || (ready && !ready())) {
    const err = new Error(signal?.aborted ? "the wait was cancelled" : "the wait deadline elapsed");
    err.code = signal?.aborted ? "aborted" : "deadline";
    throw err;
  }
};
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code !== "ESRCH"; }
}
export async function withRecordLock(home, id, { signal, ready } = {}, fn) {
  const dir = pendingDir(home), prefix = `.${id}.lock.`;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  lockCheck(signal, ready);
  const name = prefix + process.pid + "." + randomUUID();
  const mine = path.join(dir, name);
  await fs.mkdir(mine, { mode: 0o700 });
  const peers = async () => {
    const found = [];
    for (const other of await fs.readdir(dir)) {
      if (!other.startsWith(prefix)) continue;
      const match = /^(\d+)\.([0-9a-f-]{36})$/.exec(other.slice(prefix.length));
      if (!match) continue;
      if (!pidAlive(Number(match[1]))) {
        await fs.rm(path.join(dir, other), { recursive: true, force: true }).catch(() => {});
        continue;
      }
      let ticket = null;
      try { ticket = Number(await fs.readFile(path.join(dir, other, "ticket"), "utf8")); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
      found.push({ name: other, ticket });
    }
    return found;
  };
  try {
    const ticket = 1 + Math.max(0, ...(await peers()).map(p => Number.isSafeInteger(p.ticket) ? p.ticket : 0));
    if (!Number.isSafeInteger(ticket)) throw new Error("record lock ticket overflow");
    const tmp = path.join(mine, "ticket.tmp");
    await fs.writeFile(tmp, String(ticket), { flag: "wx", mode: 0o600 });
    await fs.rename(tmp, path.join(mine, "ticket"));
    for (;;) {
      lockCheck(signal, ready);
      const blocked = (await peers()).some(p => p.name !== name &&
        (p.ticket === null || p.ticket < ticket || (p.ticket === ticket && p.name < name)));
      if (!blocked) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    lockCheck(signal, ready);
    return await fn();
  } finally {
    await fs.rm(mine, { recursive: true, force: true }).catch(() => {});
  }
}


// mutatePending(home, id, mutator, { signal, ready }) → { record, next }. The mutator receives
// the freshly-read record (or null when absent) and returns the record to persist — or null to
// leave disk untouched. Returning a record stamps a new local `version`/`updatedAt`; saving runs
// through the per-process write chain, so same-process writes stay ordered too.
export async function mutatePending(home, id, mutator, { signal, ready } = {}) {
  return withRecordLock(home, id, { signal, ready }, async () => {
    const record = await readPending(home, id);
    const next = await mutator(record);
    if (next === null || next === undefined) return { record, next: null };
    const stamped = { ...next, version: (record?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
    await savePending(home, stamped);
    return { record, next: stamped };
  });
}

// removePendingGuarded(home, id, predicate, opts) — unlinks only while the predicate accepts
// the fresh record, so a late cleanup cannot delete a record another process advanced.
export async function removePendingGuarded(home, id, predicate = () => true, opts = {}) {
  return withRecordLock(home, id, opts, async () => {
    const record = await readPending(home, id);
    if (predicate(record)) await fs.rm(pendingPath(home, id), { force: true });
    return record;
  });
}

export async function removePending(home, id) {
  await fs.rm(pendingPath(home, id), { force: true });
}

export async function prunePending(home, { now = Date.now(), signal, ready } = {}) {
  let names;
  try {
    names = await fs.readdir(pendingDir(home));
  } catch {
    return 0; // no pending dir yet
  }
  let pruned = 0;
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{16}\.json$/.test(name)) continue;
    const file = path.join(pendingDir(home), name);
    try {
      let createdAt = NaN;
      try {
        const record = JSON.parse(await fs.readFile(file, "utf8"));
        // v2 session records prune by last local activity: an active interview outlives
        // its creation date, while abandoned local state still expires after 3 days.
        createdAt = Date.parse(record.v === 2 ? (record.updatedAt ?? record.createdAt) : record.createdAt);
      } catch {
        /* fall back to mtime */
      }
      if (Number.isNaN(createdAt)) createdAt = (await fs.stat(file)).mtimeMs;
      if (now - createdAt > PRUNE_AFTER_MS) {
        // Re-read under the same interprocess lock as acknowledgements/publications:
        // activity after this scan must not be erased by a stale pruning decision.
        let removed = false;
        await withRecordLock(home, name.slice(0, -5), { signal, ready }, async () => {
          const fresh = await readPending(home, name.slice(0, -5));
          if (!fresh) return;
          const stamp = Date.parse(fresh.v === 2 ? (fresh.updatedAt ?? fresh.createdAt) : fresh.createdAt);
          const ageFrom = Number.isNaN(stamp) ? (await fs.stat(file)).mtimeMs : stamp;
          if (now - ageFrom <= PRUNE_AFTER_MS) return;
          await fs.rm(file, { force: true });
          removed = true;
        });
        if (removed) pruned++;
      }
    } catch (err) {
      if (err.code === "aborted" || err.code === "deadline") throw err;
      /* a file that can't be read or removed is left alone */
    }
  }
  return pruned;
}
