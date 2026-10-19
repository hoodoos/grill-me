// Persistent interview sessions (protocol v2): sendRound/waitSessionRound/finishSession/cancelSession.
// State lives in ~/.grill-me/pending/<id>.json as a v2 record, separate from legacy one-shot
// pending state:
//   { v: 2, id, secret, server, round, revision, state, grill, createdAt, updatedAt, expiresAt,
//     publication: { operationId, round, expectedRevision, ct, iv, grillHash } | null,
//     pendingAck: { round, revision, submissionId, ct, iv } | null }
// `publication` is the one exact encrypted intent persisted BEFORE the publish request; it is
// reused byte-for-byte after a lost reply and cleared only on a confirmed snapshot. `pendingAck`
// is the immutable per-round answer cache, written before delivery, cleared only by an ack that
// matches its round/submissionId exactly — a late ack can never clobber the next round. The
// order is always: cache → deliver → ack; an ack runs only from the delivery callback after a
// successful output, never from send/wait recovery paths.
import {
  convert,
  newId,
  newSecret,
  answerLines,
  contentHash,
  isId,
} from "../../core/src/index.js";
import {
  deriveSessionKeys,
  sealRound,
  openRoundAnswers,
  makeSessionLink,
  validateRound,
} from "../../core/src/session.js";
import { resolveServer, stateHome, resolveAgent } from "./config.js";
import {
  createSession,
  getSessionSnapshot,
  publishRound,
  waitRoundAnswers,
  ackRound,
  finishSession as finishRequest,
  deleteSession,
} from "./api.js";
import { readPending, savePending, removePendingGuarded, prunePending, mutatePending } from "./pending.js";
import { NOW, SLEEP, defaultBackoff, abortedError, abortableSleep, waitScope } from "./scope.js";
import { qbBucket } from "./grill.js";

const SESSION = 2;
const PUBLISH_ATTEMPTS = 3; // bounded exact-intent retries; ambiguity surfaces as PUBLISHING
const ACK_ATTEMPTS = 2;

const coded = (code, message) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

async function loadSessionRecord(home, id) {
  if (!isId(id)) throw coded("usage", "bad session id");
  const record = await readPending(home, id);
  if (!record) {
    throw coded(
      "unknown-id",
      `Unknown session ${id}: it was sent from another machine, already finished, or the id is wrong.`,
    );
  }
  if (record.v !== SESSION) {
    throw coded(
      "not-session",
      `${id} is a one-shot grill, not an interview session. Sessions start with: grill-me send --session`,
    );
  }
  if (!validateRound(record.round) || (record.pendingAck && record.pendingAck.round !== record.round)) {
    throw coded("conflict", "the local session record has conflicting round identities; no acknowledgement or publication was sent");
  }
  return record;
}

const writeTokenFor = async (record) => (await deriveSessionKeys(record.secret)).writeToken;

// ── Acknowledgement. Runs ONLY from a delivery callback after successful output. Retries the
// originally persisted request (revision/submissionId are never recomputed); every wait and
// sleep stays inside the caller's scope. Returns a verdict; never throws on transport trouble.
async function confirmAck(record, pendingAck, { server, home, agent, scope }) {
  const token = await writeTokenFor(record);
  let lastErr;
  for (let attempt = 0; attempt <= ACK_ATTEMPTS; attempt++) {
    scope.assertReady(); // no request, lock wait or sleep past the caller's deadline
    try {
      const res = await ackRound(
        server,
        record.id,
        pendingAck.round,
        token,
        { expectedRevision: pendingAck.revision, submissionId: pendingAck.submissionId },
        { agent, signal: scope.signal },
      );
      if (res.status === 204) {
        // Guarded commit: clear only our own round's cache. If another process already advanced
        // the session, the fresh record no longer matches — leave it untouched.
        await mutatePending(
          home,
          record.id,
          (fresh) => {
            if (!fresh || fresh.v !== SESSION || fresh.round !== pendingAck.round) return null;
            const ack = fresh.pendingAck;
            if (!ack || ack.round !== pendingAck.round || ack.submissionId !== pendingAck.submissionId) return null;
            return {
              ...fresh,
              state: "idle",
              revision: pendingAck.revision + 1, // the ack transition increments the revision once
              grill: null, // the collected round's plaintext is no longer retained
              publication: fresh.publication?.round === pendingAck.round ? null : fresh.publication,
              pendingAck: null,
            };
          },
          { signal: scope.signal, ready: () => scope.ready() },
        );
        return "confirmed";
      }
      return "conflict"; // 409: wrong current submission/version
    } catch (err) {
      lastErr = err;
      if (err.code === "gone") return "gone";
      if (err.code === "aborted" || err.code === "deadline") throw err;
      if (attempt < ACK_ATTEMPTS) {
        const delay = Math.min(1000 * (attempt + 1), scope.remaining());
        await abortableSleep(delay, scope.signal);
      }
    }
  }
  return "ambiguous";
}

// The ANSWERS handoff: output callback first, ack only after the caller confirms delivery.
function answersResult({ dir, record, target, revision, submissionId, lines, answers, srv, ag, scope }) {
  const pendingAck = { round: target, revision, submissionId };
  return {
    status: "ANSWERS",
    session: true,
    id: record.id,
    round: target,
    revision,
    submissionId,
    lines,
    answers,
    canDeliver: () => scope.ready(),
    deliverySignal: scope.signal,
    dispose: () => scope.close(),
    async ack() {
      try {
        scope.assertReady();
        const marked = await mutatePending(dir, record.id, fresh => {
          const cache = fresh?.pendingAck;
          if (fresh?.round !== target || cache?.round !== target || cache.submissionId !== submissionId || cache.revision !== revision) return null;
          return { ...fresh, pendingAck: { ...cache, delivered: true } };
        }, { signal: scope.signal, ready: () => scope.ready() });
        if (!marked.next) throw coded("conflict", "the cached round changed before acknowledgement");
        const verdict = await confirmAck(record, pendingAck, { server: srv, home: dir, agent: ag, scope });
        if (verdict !== "confirmed") {
          const why = {
            conflict: "the server rejected the acknowledgement",
            gone: "the session ended before the acknowledgement",
            ambiguous: "the acknowledgement is unconfirmed",
          }[verdict];
          throw coded(verdict === "gone" ? "gone" : "unconfirmed", `${why}; encrypted answers for round ${target} are kept locally`);
        }
      } finally {
        scope.close();
      }
    },
  };
}

// ── Publish. `post` performs one exact request; 409 is definitive, transport errors retry
// against the caller's bound. Never clears the saved intent on an ambiguous failure.
async function publishAttempts(post, { attempts = PUBLISH_ATTEMPTS, signal, sleep = SLEEP, success = [200, 201] }) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw abortedError();
    try {
      const res = await post();
      if (success.includes(res.status)) return { confirmed: res.json ?? {} };
      return { conflict: res.json ?? {} }; // a different request with this operation → 409
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw abortedError();
      if (err.code === "aborted") throw err;
      if (err.code !== "network" && err.code !== "server" && err.code !== "limited") throw err;
      if (attempt < attempts) await (signal ? abortableSleep(250 * attempt, signal) : sleep(250 * attempt));
    }
  }
  return { ambiguous: lastErr };
}

function publishingResult(record, grill, link) {
  if (!record?.publication) throw coded("conflict", "another process resolved the saved publication; re-read this explicit session with wait/fetch");
  // Recovery identity only: the link identifies the saved intent, but the phone is NOT ready —
  // the round is unconfirmed until a confirmed snapshot says it is live.
  return {
    status: "PUBLISHING",
    session: true,
    id: record.id,
    round: record.publication.round,
    message: `Round ${record.publication.round} publication is UNCONFIRMED. Retry this saved id/round and identical questions; do not create another session or present the phone as ready.`,
    link,
    count: grill.questions.length,
    expiresAt: record.expiresAt ?? undefined,
  };
}

function pendingResult(record, grill, link) {
  return {
    status: record.state === "idle" ? "IDLE" : record.state === "answered" ? "ANSWERED" : "PENDING",
    session: true,
    id: record.id,
    round: record.round,
    revision: record.revision,
    state: record.state,
    link,
    count: grill.questions.length,
    expiresAt: record.expiresAt ?? undefined,
  };
}

// Commit a confirmed publication snapshot: the fresh record must still carry our intent. The
// server snapshot is authoritative for state/revision — an exact retry after a lost reply can
// lawfully answer 200 with the round already answered or idle.
async function commitPublication(home, record, operationId, grill, snap) {
  const intent = record.publication;
  if (snap?.v !== SESSION || snap.id !== record.id || snap.round !== intent?.round || snap.operationId !== operationId ||
      !Number.isInteger(snap.revision) || snap.revision < 1 || snap.revision > 2147483647 ||
      !["pending", "answered", "idle"].includes(snap.state) ||
      (snap.state !== "idle" && (snap.ct !== intent.ct || snap.iv !== intent.iv))) {
    throw coded("unconfirmed", "the publication reply did not confirm the saved operation; retry this id/round with the same questions");
  }
  const committed = await mutatePending(home, record.id, (fresh) => {
    if (!fresh || fresh.v !== SESSION) return null;
    if (fresh.publication?.operationId !== operationId) return null; // superseded concurrently
    return {
      ...fresh,
      round: fresh.publication.round,
      revision: snap.revision,
      state: snap.state === "pending" || snap.state === "answered" || snap.state === "idle" ? snap.state : "pending",
      grill: snap.state === "idle" ? null : grill,
      expiresAt: snap.expiresAt ?? fresh.expiresAt,
      publication: null,
    };
  });
  if (!committed.next) throw coded("conflict", "the local publication changed before confirmation; re-read this explicit session");
  return committed.next;
}

// sendRound(input, { id?, round?, expectedRevision?, ... }): without id, creates round 1 of a new
// session; with an id, publishes the explicit next round, resuming a saved intent exactly when
// one exists (including the initial round 1 after a lost create reply).
export async function sendRound(input, { title, id, round, expectedRevision, server, home, agent, signal, attempts, now = NOW, sleep = SLEEP } = {}) {
  const dir = stateHome(home);
  await prunePending(dir);
  const res = convert(input, { title });
  if (!res.ok) throw coded("input", res.error);
  const grill = res.grill;
  const grillHash = await contentHash(grill);
  const ag = resolveAgent(agent);

  // Create: the caller does not know the generated id yet, so the intent is persisted BEFORE the
  // request; an ambiguous reply is surfaced as PUBLISHING with that id/round for an exact retry.
  if (id === undefined || id === null || id === "") {
    if ((round !== undefined && round !== 1) || expectedRevision !== undefined) {
      throw coded("usage", "starting a session creates round 1; subsequent rounds require the saved id");
    }
    const srv = resolveServer(server);
    for (let identity = 0; identity < 3; identity++) {
      const freshId = newId();
      const secret = newSecret();
      const sealed = await sealRound(grill, { id: freshId, secret, round: 1 });
      const operationId = newId();
      const record = {
        v: SESSION,
        id: freshId,
        secret,
        server: srv,
        round: 1,
        revision: 0,
        state: "idle",
        grill,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        publication: { operationId, round: 1, expectedRevision: 0, ct: sealed.ct, iv: sealed.iv, grillHash },
        pendingAck: null,
      };
      await savePending(dir, record); // durable BEFORE the first request
      const outcome = await publishAttempts(
        () => createSession(srv, { id: freshId, round: 1, operationId, ct: sealed.ct, iv: sealed.iv, writeHash: sealed.writeHash, qb: qbBucket(grill.questions.length) }, { agent: ag, signal }),
        { attempts, signal, sleep },
      );
      if (outcome.confirmed) {
        const committed = await commitPublication(dir, record, operationId, grill, outcome.confirmed);
        return pendingResult(committed, grill, makeSessionLink(committed.id, committed.secret, srv));
      }
      if (outcome.conflict) {
        await removePendingGuarded(dir, freshId, (r) => r?.publication?.operationId === operationId);
        continue; // id taken across both namespaces; re-seal under a fresh one
      }
      const kept = (await readPending(dir, freshId)) ?? record;
      return publishingResult(kept, grill, makeSessionLink(freshId, secret, srv));
    }
    throw coded("server", "the server rejected 3 fresh session ids; try again");
  }

  // Reuse: explicit id + explicit next round; never a global-latest lookup.
  if (!isId(String(id))) throw coded("usage", `bad session id "${id}"`);
  if (!validateRound(round)) {
    throw coded("usage", "publishing on a session needs the explicit next round: send --id <id> --round <n>");
  }
  let record = await loadSessionRecord(dir, String(id));
  const srv = resolveServer(server || record.server);

  // An unconfirmed answer cache is never acked from here (that would erase undelivered answers):
  // deliver it first — wait/fetch replays the cache and acks only after successful output.
  if (record.pendingAck?.delivered) {
    const scope = waitScope(45, signal);
    try {
      const verdict = await confirmAck(record, record.pendingAck, { server: srv, home: dir, agent: ag, scope });
      if (verdict !== "confirmed") throw coded("unconfirmed", "previous delivered answers still need acknowledgement; retry wait/fetch");
    } finally { scope.close(); }
    record = await loadSessionRecord(dir, String(id));
  }
  if (record.pendingAck) {
    throw coded(
      "unconfirmed",
      `round ${record.pendingAck.round} answers are cached but not yet acknowledged; run wait/fetch for ${record.id} to deliver them before publishing round ${record.round + 1}`,
    );
  }

  // A saved publication intent (this exact round, or the initial round 1) resumes byte-exact.
  if (record.publication) {
    const intent = record.publication;
    if (intent.round !== round) {
      throw coded("conflict", `round ${round} was requested, but the unconfirmed publication is for round ${intent.round}; retry with that round (same questions) or wait for its confirmation`);
    }
    if (intent.grillHash !== grillHash) {
      throw coded("conflict", `different questions than the saved publication intent for round ${round}; publish the next round instead, or finish the session`);
    }
    if (round === 1) {
      // Resuming the initial create: same endpoint and byte-exact blob/operation id.
      const { writeHash } = await deriveSessionKeys(record.secret);
      const outcome = await publishAttempts(
        () => createSession(srv, { id: record.id, round: 1, operationId: intent.operationId, ct: intent.ct, iv: intent.iv, writeHash, qb: qbBucket(grill.questions.length) }, { agent: ag, signal }),
        { attempts, signal, sleep },
      );
      return await finishResume(dir, record, intent, grill, srv, outcome);
    }
    const token = await writeTokenFor(record);
    const body = { round, expectedRevision: intent.expectedRevision, operationId: intent.operationId, ct: intent.ct, iv: intent.iv, qb: qbBucket(grill.questions.length) };
    const outcome = await publishAttempts(() => publishRound(srv, record.id, token, body, { agent: ag, signal }), { attempts, signal, sleep });
    return await finishResume(dir, record, intent, grill, srv, outcome);
  }

  // No saved intent: read the live session; the idle revision is always sent as expectedRevision.
  const snapRes = await getSessionSnapshot(srv, record.id, { agent: ag, signal });
  if (snapRes.status === 404) throw coded("gone", "The session ended or expired.");
  const snap = snapRes.json;
  if (!snap) throw coded("server", "the session snapshot came back empty");
  if (snap.state === "answered") throw coded("uncollected", `round ${snap.round} answers are still uncollected; run wait/fetch for them before publishing round ${snap.round + 1}`);
  if (snap.state === "pending") throw coded("pending-round", `round ${snap.round} is still pending on the phone; collect or cancel it before publishing the next round`);
  const expected = snap.revision;
  if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== expected) {
    throw coded("conflict", `expectedRevision ${expectedRevision} does not match the session's current revision ${expected}; re-read and retry`);
  }
  if (round !== snap.round + 1) throw coded("usage", `round must be the explicit next round: ${snap.round + 1}`);

  const sealed = await sealRound(grill, { id: record.id, secret: record.secret, round });
  const operationId = newId();
  // Guarded intent: refuse to overwrite if another process advanced the session meanwhile.
  const staked = await mutatePending(dir, record.id, (fresh) => {
    if (!fresh || fresh.v !== SESSION) return null;
    if (fresh.pendingAck) throw coded("unconfirmed", `round ${fresh.pendingAck.round} answers are cached but not yet acknowledged; deliver them before publishing`);
    if (fresh.publication) throw coded("conflict", `an unconfirmed publication for round ${fresh.publication.round} exists; resume that round instead`);
    if (fresh.state !== "idle" || fresh.revision !== expected || fresh.round !== snap.round) {
      throw coded("conflict", "the session advanced concurrently; re-read and retry the same round");
    }
    return { ...fresh, publication: { operationId, round, expectedRevision: expected, ct: sealed.ct, iv: sealed.iv, grillHash } };
  });
  const token = await writeTokenFor(staked.next);
  const body = { round, expectedRevision: expected, operationId, ct: sealed.ct, iv: sealed.iv, qb: qbBucket(grill.questions.length) };
  const outcome = await publishAttempts(() => publishRound(srv, record.id, token, body, { agent: ag, signal }), { attempts, signal, sleep });
  return await finishResume(dir, staked.next, staked.next.publication, grill, srv, outcome);
}

// Shared tail of the reuse paths: turn the publish outcome into a result, keeping the intent on
// ambiguity and surfacing conflicts without claiming success.
async function finishResume(dir, record, intent, grill, srv, outcome) {
  const link = () => makeSessionLink(record.id, record.secret, srv);
  if (outcome.confirmed) {
    const committed = await commitPublication(dir, record, intent.operationId, grill, outcome.confirmed);
    return pendingResult(committed, grill, link());
  }
  if (outcome.conflict) {
    const detail = outcome.conflict?.error ? `: ${outcome.conflict.error}` : "";
    throw coded("conflict", `the server did not accept round ${intent.round}${detail}; re-check the session (wait/fetch) and retry the same round if it is still idle`);
  }
  const kept = (await readPending(dir, record.id)) ?? record;
  return publishingResult(kept, grill, link());
}

// ── Waiting. Dispatched from grill.js wait()/check() when the local record is a v2 session.
// A cached round (pendingAck) is always replayed to ANSWERS first — it may be there because a
// previous delivery failed or was cancelled — and the ack runs only from the caller's delivery
// callback. Recovery never acknowledges.
export async function waitSessionRound(id, { round, seconds = Infinity, once = false, onRetry, server, home, agent, signal, now = NOW, sleep = SLEEP, pollSeconds = 50, offlineMs = 5 * 60 * 1000, backoffMs = defaultBackoff, scope: inheritedScope } = {}) {
  const dir = stateHome(home);
  const scope = inheritedScope ?? waitScope(seconds, signal, now);
  let record;
  let handedOff = false;
  try {
    await prunePending(dir, { signal: scope.signal, ready: () => scope.ready() });
    record = await loadSessionRecord(dir, id);
    const srv = resolveServer(server || record.server);
    const ag = resolveAgent(agent);
    if (round !== undefined && round !== null && round !== record.round) {
      throw coded("stale-round", `this session is at round ${record.round}, not ${round}; use the current round`);
    }
    const target = record.round;

    if (record.pendingAck) {
      // Replay the durable encrypted cache; delivery and ack gate on the caller's output.
      const cache = record.pendingAck;
      const blob = { ct: cache.ct, iv: cache.iv };
      const answers = await openRoundAnswers(blob, record.grill, { id, secret: record.secret, round: cache.round });
      const lines = answerLines(record.grill, answers);
      if (!scope.ready()) return { status: "WAITING", session: true, id, round: target };
      const result = answersResult({ dir, record, target: cache.round, revision: cache.revision, submissionId: cache.submissionId, lines, answers, srv, ag, scope });
      handedOff = true;
      return result;
    }

    if (record.publication) return { status: "PUBLISHING", session: true, id, round: target, link: makeSessionLink(id, record.secret, srv), message: `round ${target} publication is unconfirmed; retry grill_send with this id and round ${target} (same questions)` };
    if (record.state === "idle") {
      return {
        status: "IDLE",
        session: true,
        id,
        round: target,
        revision: record.revision,
        state: "idle",
        message: `round ${target} was already collected; the session is idle`,
      };
    }

    let lastOk = now();
    let failures = 0;
    for (;;) {
      if (!scope.ready()) return { status: "WAITING", session: true, id, round: target };
      const waitParam = once ? 0 : Math.max(0, Math.min(pollSeconds, Math.ceil(scope.remaining() / 1000)));
      let res;
      try {
        res = await waitRoundAnswers(srv, id, target, waitParam, { agent: ag, signal: scope.signal });
      } catch (err) {
        if (!scope.ready()) return { status: "WAITING", session: true, id, round: target };
        if (err.code === "gone") return { status: "EXPIRED", session: true, id, round: target };
        if (once || !["network", "server", "limited"].includes(err.code)) throw err;
        failures++;
        if (now() - lastOk >= offlineMs) return { status: "OFFLINE", session: true, id, round: target };
        const delayMs = Math.min(backoffMs(failures), scope.remaining());
        onRetry?.({ error: err, delayMs, attempt: failures });
        await (Number.isFinite(scope.remaining()) || signal
          ? abortableSleep(delayMs, scope.signal) : sleep(delayMs));
        continue;
      }
      lastOk = now();
      failures = 0;
      if (res.status === 204) {
        if (once) return { status: "WAITING", session: true, id, round: target };
        continue;
      }
      if (res.status === 404) return { status: "EXPIRED", session: true, id, round: target };
      if (res.status === 409) {
        // A different round is current locally: adopt the live identity, never a heuristic.
        // Never adopt an unknown round while retaining this round's plaintext or cache.
        // The explicit publisher owns the durable next-round identity and question data.
        return { status: "CONFLICT", session: true, id, round: target, message: `the session moved past round ${target}; use its current round` };
      }
      // 200: answers for the target round. Cache the exact blob before any delivery; the guard
      // refuses to write into a record another process advanced past this round.
      const blob = { ct: res.json.ct, iv: res.json.iv };
      const answers = await openRoundAnswers(blob, record.grill, { id, secret: record.secret, round: target });
      const lines = answerLines(record.grill, answers);
      try {
        const cached = await mutatePending(dir, id, (fresh) => {
          if (!fresh || fresh.v !== SESSION || fresh.round !== target || fresh.publication) return null;
          if (fresh.pendingAck) {
            if (fresh.pendingAck.submissionId === res.json.submissionId) return null; // immutable: keep the original
            throw coded("conflict", `a different submission (${res.json.submissionId}) won round ${target}`);
          }
          if (fresh.state === "idle" || fresh.version !== record.version) return null;
          return {
            ...fresh,
            pendingAck: {
              round: target,
              revision: res.json.revision,
              submissionId: res.json.submissionId,
              ct: blob.ct,
              iv: blob.iv,
            },
          };
        }, { signal: scope.signal, ready: () => scope.ready() });
        const cache = (cached.next ?? cached.record)?.pendingAck;
        if (!cache || cache.round !== target || cache.submissionId !== res.json.submissionId || cache.ct !== blob.ct || cache.iv !== blob.iv || cache.revision !== res.json.revision) {
          return { status: "CONFLICT", session: true, id, round: target, message: "the local round changed before answers could be cached; no acknowledgement was sent" };
        }
      } catch (err) {
        if (err.code === "conflict") return { status: "CONFLICT", session: true, id, round: target, message: err.message };
        throw err;
      }
      if (!scope.ready()) return { status: "WAITING", session: true, id, round: target };
      const result = answersResult({ dir, record, target, revision: res.json.revision, submissionId: res.json.submissionId, lines, answers, srv, ag, scope });
      handedOff = true;
      return result;
    }
  } catch (err) {
    if (signal?.aborted) throw abortedError();
    if (!scope.ready()) return { status: "WAITING", session: true, id, round: record?.round };
    throw err;
  } finally {
    if (!handedOff) scope.close();
  }
}

// finish(id): end an idle session. Refuses any unconfirmed publication or answer cache.
export async function finishSession(id, { expectedRevision, server, home, agent, signal, attempts, sleep = SLEEP } = {}) {
  const dir = stateHome(home);
  const record = await loadSessionRecord(dir, id);
  if (record.pendingAck) throw coded("unconfirmed", `finish refused: round ${record.pendingAck.round} answers are delivered but unacknowledged; deliver them first (wait/fetch replays the cache)`);
  if (record.publication) throw coded("unconfirmed", `finish refused: round ${record.publication.round} publication is unconfirmed; confirm it first`);
  const srv = resolveServer(server || record.server);
  const ag = resolveAgent(agent);
  const snapRes = await getSessionSnapshot(srv, id, { agent: ag, signal });
  if (snapRes.status === 404) {
    await removePendingGuarded(dir, id, (r) => r?.v === SESSION && !r.pendingAck && !r.publication);
    return { status: "EXPIRED", session: true, id };
  }
  const snap = snapRes.json;
  if (snap.state !== "idle") {
    throw coded(snap.state === "answered" ? "uncollected" : "pending-round", `finish requires an idle session; round ${snap.round} is ${snap.state}`);
  }
  if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== snap.revision) {
    throw coded("conflict", `expectedRevision ${expectedRevision} does not match the session's current revision ${snap.revision}`);
  }
  const token = await writeTokenFor(record);
  const outcome = await publishAttempts(
    () => finishRequest(srv, id, token, { expectedRevision: snap.revision }, { agent: ag, signal }),
    { attempts, signal, sleep, success: [204] },
  );
  if (outcome.confirmed) {
    await removePendingGuarded(dir, id, (r) => r?.v === SESSION && !r.pendingAck && !r.publication);
    return { status: "FINISHED", session: true, id };
  }
  if (outcome.conflict) {
    const detail = outcome.conflict?.error ? `: ${outcome.conflict.error}` : "";
    throw coded("conflict", `the server did not finish the session${detail}; re-check it (wait/fetch) and retry finish`);
  }
  throw coded("unconfirmed", "finish is unconfirmed (no server reply); the session record is kept — retry finish");
}

// cancel(id): explicit abort from any state, the session variant of the legacy cancel.
export async function cancelSession(id, { server, home, agent, signal } = {}) {
  const dir = stateHome(home);
  const record = await loadSessionRecord(dir, id);
  const srv = resolveServer(server || record.server);
  const token = await writeTokenFor(record);
  try {
    await deleteSession(srv, id, token, { agent: resolveAgent(agent), signal });
  } catch (err) {
    if (err.code !== "gone") throw err; // 404 counts as success
  }
  await removePendingGuarded(dir, id, () => true);
  return { status: "CANCELLED", session: true, id };
}
