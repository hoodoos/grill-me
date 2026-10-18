// The operations behind the CLI (and, in milestone 4, the MCP tools). Functions return results;
// the CLI prints them. State lives in ~/.grill-me/pending/<id>.json (see pending.js).
import {
  convert,
  newSecret,
  deriveKeys,
  sealGrill,
  openAnswers,
  answerLines,
  makeLink,
} from "../../core/src/index.js";
import { resolveServer, stateHome } from "./config.js";
import { createGrill, waitAnswers, deleteGrill } from "./api.js";
import { savePending, readPending, removePending, prunePending } from "./pending.js";
import { qrText } from "./qr.js";

const NOW = () => Date.now();
const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const defaultBackoff = (failures, { baseMs = 1000, capMs = 30000 } = {}) =>
  Math.min(capMs, baseMs * 2 ** (failures - 1));

async function loadPending(home, id) {
  const pending = await readPending(home, id);
  if (!pending) {
    const err = new Error(
      `Unknown grill ${id}: it was sent from another machine, or its answers were already fetched.`,
    );
    err.code = "unknown-id";
    throw err;
  }
  return pending;
}

// Convert, seal and upload a grill, then record it locally. Shared by send and resend.
async function uploadGrill(grill, { server, home, qrMode }) {
  const { id, secret, expiresAt } = await createGrill(server, async (freshId) => {
    const freshSecret = newSecret();
    const { ct, iv, writeHash } = await sealGrill(grill, { id: freshId, secret: freshSecret });
    return { secret: freshSecret, ct, iv, writeHash };
  });
  await savePending(home, {
    v: 1,
    id,
    secret,
    server,
    grill,
    createdAt: new Date().toISOString(),
    expiresAt,
  });
  const link = makeLink(id, secret, server);
  const qr = qrMode === "off" ? null : qrText(link, { mode: qrMode });
  return { id, link, qr, count: grill.questions.length, expiresAt };
}

// Answers arrived: decrypt, print lines, DELETE (retry twice on network errors),
// and remove the pending file whatever happened.
async function collect(pending, blob, { server, home, sleep = SLEEP }) {
  const answers = await openAnswers(blob, pending.grill, { id: pending.id, secret: pending.secret });
  const lines = answerLines(pending.grill, answers);
  const { writeToken } = await deriveKeys(pending.secret);
  try {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await deleteGrill(server, pending.id, writeToken);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err.code !== "network") break; // gone/server/bad: the grill is already as good as deleted
        if (attempt < 2) await sleep(1000 * (attempt + 1));
      }
    }
    return { status: "ANSWERS", lines, answers, deleteError: lastErr?.code === "network" ? lastErr.message : null };
  } finally {
    await removePending(home, pending.id).catch(() => {});
  }
}

export async function send(input, { title, server, qr = "dark", home } = {}) {
  const dir = stateHome(home);
  await prunePending(dir);
  const res = convert(input, { title });
  if (!res.ok) {
    const err = new Error(res.error);
    err.code = "input";
    err.schema = res.schema;
    throw err;
  }
  return uploadGrill(res.grill, { server: resolveServer(server), home: dir, qrMode: qr });
}

export async function wait(id, { seconds = Infinity, onRetry, server, home, now = NOW, sleep = SLEEP, pollSeconds = 50, offlineMs = 5 * 60 * 1000, backoffMs = defaultBackoff } = {}) {
  const dir = stateHome(home);
  await prunePending(dir, { now: now() });
  const pending = await loadPending(dir, id);
  const srv = resolveServer(server || pending.server);
  const start = now();
  let lastOk = start;
  let failures = 0;
  for (;;) {
    if (now() - start >= seconds * 1000) return { status: "WAITING" };
    let res;
    try {
      res = await waitAnswers(srv, id, pollSeconds);
    } catch (err) {
      if (err.code === "gone") return { status: "EXPIRED" };
      if (err.code !== "network" && err.code !== "server" && err.code !== "limited") throw err;
      failures++;
      if (now() - lastOk >= offlineMs) return { status: "OFFLINE" };
      const delayMs = backoffMs(failures);
      onRetry?.({ error: err, delayMs, attempt: failures });
      await sleep(delayMs);
      continue;
    }
    lastOk = now();
    failures = 0;
    if (res.status === 204) continue;
    return collect(pending, res.json, { server: srv, home: dir, sleep });
  }
}

// One wait=0 request; nothing yet → WAITING.
export async function fetch(id, { server, home, sleep = SLEEP } = {}) {
  const dir = stateHome(home);
  await prunePending(dir);
  const pending = await loadPending(dir, id);
  const srv = resolveServer(server || pending.server);
  let res;
  try {
    res = await waitAnswers(srv, id, 0);
  } catch (err) {
    if (err.code === "gone") return { status: "EXPIRED" };
    throw err;
  }
  if (res.status === 204) return { status: "WAITING" };
  return collect(pending, res.json, { server: srv, home: dir, sleep });
}

// Re-upload the same grill under a new id and a new secret. The phone resumes its progress,
// because that progress is keyed by the grill's content.
export async function resend(id, { qr = "dark", server, home } = {}) {
  const dir = stateHome(home);
  await prunePending(dir);
  const pending = await loadPending(dir, id);
  const srv = resolveServer(server || pending.server);
  const result = await uploadGrill(pending.grill, { server: srv, home: dir, qrMode: qr });
  try {
    const { writeToken } = await deriveKeys(pending.secret);
    await deleteGrill(srv, id, writeToken);
  } catch {
    /* the old grill is already gone or unreachable; it expires on its own */
  }
  await removePending(dir, id);
  return result;
}

export async function cancel(id, { server, home } = {}) {
  const dir = stateHome(home);
  await prunePending(dir);
  const pending = await loadPending(dir, id);
  const srv = resolveServer(server || pending.server);
  const { writeToken } = await deriveKeys(pending.secret);
  try {
    await deleteGrill(srv, id, writeToken);
  } catch (err) {
    if (err.code !== "gone") throw err; // 404 counts as success
  }
  await removePending(dir, id);
  return { status: "CANCELLED" };
}
