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
import { resolveServer, stateHome, resolveAgent } from "./config.js";
import { createGrill, waitAnswers, deleteGrill } from "./api.js";
import { savePending, readPending, removePending, prunePending } from "./pending.js";
import { qrText } from "./qr.js";
import { NOW, SLEEP, defaultBackoff, abortedError, abortableSleep, waitScope } from "./scope.js";
import { waitSessionRound, cancelSession } from "./session.js";

const coded = (code, message) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

// The question-count bucket sent as `qb` on create (daily metrics, no per-grill data).
export const qbBucket = (n) =>
  n === 1 ? "1" : n <= 3 ? "2-3" : n <= 6 ? "4-6" : n <= 10 ? "7-10" : n <= 20 ? "11-20" : "21-30";

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
async function uploadGrill(grill, { server, home, qrMode, agent }) {
  const { id, secret, expiresAt } = await createGrill(
    server,
    async (freshId) => {
      const freshSecret = newSecret();
      const { ct, iv, writeHash } = await sealGrill(grill, { id: freshId, secret: freshSecret });
      return { secret: freshSecret, ct, iv, writeHash };
    },
    { qb: qbBucket(grill.questions.length), agent },
  );
  await savePending(home, {
    v: 1,
    id,
    secret,
    server,
    grill,
    createdAt: new Date().toISOString(),
    expiresAt, // epoch milliseconds from the server
  });
  const link = makeLink(id, secret, server);
  const qr = qrMode === "off" ? null : qrText(link, { mode: qrMode });
  return { id, link, qr, count: grill.questions.length, expiresAt };
}

// One absolute budget spans polling, retries, delivery and acknowledgement (see scope.js).

// Persist only the encrypted answer blob before handing any answers to a caller. The explicit
// ack phase must run only after successful delivery. A failed/ambiguous DELETE keeps the cache,
// including when the server committed DELETE but its reply was lost.
async function collect(pending, blob, { server, home, agent, scope }) {
  const answers = await openAnswers(blob, pending.grill, { id: pending.id, secret: pending.secret });
  const lines = answerLines(pending.grill, answers);
  if (!pending.answerBlob) {
    await savePending(home, { ...pending, answerBlob: { ct: blob.ct, iv: blob.iv } });
  }
  if (!scope.ready()) return { status: "WAITING" };
  let acknowledged = false;
  return {
    status: "ANSWERS", lines, answers,
    canDeliver: () => scope.ready(),
    deliverySignal: scope.signal,
    dispose: () => scope.close(),
    async ack() {
      try {
        if (acknowledged) return;
        scope.assertReady();
        const { writeToken } = await deriveKeys(pending.secret);
        for (let attempt = 0; ; attempt++) {
          scope.assertReady();
          try {
            const res = await deleteGrill(server, pending.id, writeToken, { agent, signal: scope.signal });
            if (res.status !== 204) throw new Error("DELETE did not confirm cleanup");
            break;
          } catch (err) {
            scope.assertReady();
            if (err.code === "gone") break; // confirmed 404 is also an acknowledgement
            if (err.code !== "network" || attempt >= 2) throw err;
            const delay = Math.min(1000 * (attempt + 1), scope.remaining());
            await abortableSleep(delay, scope.signal);
          }
        }
        scope.assertReady();
        await removePending(home, pending.id);
        // unlink itself cannot accept an AbortSignal. If cancellation/deadline raced it,
        // restore the encrypted recovery record rather than dropping the final local copy.
        if (scope.signal.aborted || scope.remaining() <= 0) {
          await savePending(home, { ...pending, answerBlob: { ct: blob.ct, iv: blob.iv } });
          scope.assertReady();
        }
        acknowledged = true;
      } finally {
        scope.close();
      }
    },
  };
}

export async function send(input, { title, server, qr = "off", home, agent } = {}) {
  const dir = stateHome(home);
  await prunePending(dir);
  const res = convert(input, { title });
  if (!res.ok) {
    const err = new Error(res.error);
    err.code = "input";
    err.schema = res.schema;
    throw err;
  }
  return uploadGrill(res.grill, { server: resolveServer(server), home: dir, qrMode: qr, agent: resolveAgent(agent) });
}

export async function wait(id, { round, seconds = Infinity, onRetry, server, home, agent, signal, now = NOW, sleep = SLEEP, pollSeconds = 50, offlineMs = 5 * 60 * 1000, backoffMs = defaultBackoff, once = false } = {}) {
  const dir = stateHome(home);
  const scope = waitScope(seconds, signal, now);
  let handedOff = false;
  try {
    await prunePending(dir, { signal: scope.signal, ready: () => scope.ready() });
    const existing = await readPending(dir, id);
    if (existing?.v === 2) {
      handedOff = true; // the session implementation owns this same absolute scope
      return await waitSessionRound(id, { round, seconds, once, onRetry, server, home, agent, signal, now, sleep, pollSeconds, offlineMs, backoffMs, scope });
    }
    const pending = await loadPending(dir, id);
    const srv = resolveServer(server || pending.server);
    const ag = resolveAgent(agent);
    const finish = async (blob) => {
      const result = await collect(pending, blob, { server: srv, home: dir, agent: ag, scope });
      handedOff = result.status === "ANSWERS";
      return result;
    };
    if (!scope.ready()) return { status: "WAITING" };
    // Recovery must precede any server request: the server may already have deleted the grill.
    if (pending.answerBlob) return await finish(pending.answerBlob);
    let lastOk = now();
    let failures = 0;
    for (;;) {
      if (!scope.ready()) return { status: "WAITING" };
      const waitParam = once ? 0 : Math.max(0, Math.min(pollSeconds, Math.ceil(scope.remaining() / 1000)));
      let res;
      try {
        res = await waitAnswers(srv, id, waitParam, { agent: ag, signal: scope.signal });
      } catch (err) {
        if (!scope.ready()) return { status: "WAITING" };
        if (err.code === "gone") return { status: "EXPIRED" };
        if (once || !["network", "server", "limited"].includes(err.code)) throw err;
        failures++;
        if (now() - lastOk >= offlineMs) return { status: "OFFLINE" };
        const delayMs = Math.min(backoffMs(failures), scope.remaining());
        onRetry?.({ error: err, delayMs, attempt: failures });
        await (Number.isFinite(scope.remaining()) || signal
          ? abortableSleep(delayMs, scope.signal) : sleep(delayMs));
        continue;
      }
      lastOk = now();
      failures = 0;
      if (res.status !== 204) return await finish(res.json);
      if (once) return { status: "WAITING" };
    }
  } catch (err) {
    if (signal?.aborted) throw abortedError();
    if (!scope.ready()) return { status: "WAITING" };
    throw err;
  } finally {
    if (!handedOff) scope.close();
  }
}

// One wait=0 request ("check grill"); cached answers are replayed before going to the server.
// Library callers explicitly ack only after successfully delivering the returned answer lines.
export function check(id, options = {}) {
  return wait(id, { ...options, once: true });
}

// Re-upload the same grill under a new id and a new secret. The phone resumes its progress,
// because that progress is keyed by the grill's content.
export async function resend(id, { qr = "off", server, home, agent } = {}) {
  const dir = stateHome(home);
  await prunePending(dir);
  const pending = await loadPending(dir, id);
  if (pending.v === 2) {
    throw coded("not-session", `${id} is an interview session: it is not resent. Publish the next round (send --id ${id} --round ${pending.round + 1}) or finish it.`);
  }
  const srv = resolveServer(server || pending.server);
  const ag = resolveAgent(agent);
  const result = await uploadGrill(pending.grill, { server: srv, home: dir, qrMode: qr, agent: ag });
  try {
    const { writeToken } = await deriveKeys(pending.secret);
    await deleteGrill(srv, id, writeToken, { agent: ag });
  } catch {
    /* the old grill is already gone or unreachable; it expires on its own */
  }
  await removePending(dir, id);
  return result;
}

export async function cancel(id, { server, home, agent, signal } = {}) {
  const dir = stateHome(home);
  await prunePending(dir);
  const pending = await loadPending(dir, id);
  if (pending.v === 2) return cancelSession(id, { server, home, agent, signal });
  const srv = resolveServer(server || pending.server);
  const { writeToken } = await deriveKeys(pending.secret);
  try {
    await deleteGrill(srv, id, writeToken, { agent: resolveAgent(agent) });
  } catch (err) {
    if (err.code !== "gone") throw err; // 404 counts as success
  }
  await removePending(dir, id);
  return { status: "CANCELLED" };
}
