// ~/.grill-me/pending/<id>.json — the local record of a sent grill: { v, id, secret, server, grill, createdAt, expiresAt }.
// Written atomically (temp file + rename) with mode 0600; files older than 3 days are pruned.
import fs from "node:fs/promises";
import path from "node:path";

const PRUNE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const pendingDir = (home) => path.join(home, "pending");
const pendingPath = (home, id) => path.join(pendingDir(home), `${id}.json`);

export async function savePending(home, record) {
  const dir = pendingDir(home);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = pendingPath(home, record.id);
  const tmp = path.join(dir, `.${record.id}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
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

export async function removePending(home, id) {
  await fs.rm(pendingPath(home, id), { force: true });
}

export async function prunePending(home, { now = Date.now() } = {}) {
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
        createdAt = Date.parse(JSON.parse(await fs.readFile(file, "utf8")).createdAt);
      } catch {
        /* fall back to mtime */
      }
      if (Number.isNaN(createdAt)) createdAt = (await fs.stat(file)).mtimeMs;
      if (now - createdAt > PRUNE_AFTER_MS) {
        await fs.rm(file, { force: true });
        pruned++;
      }
    } catch {
      /* a file that can't be read or removed is left alone */
    }
  }
  return pruned;
}
