// A fetch client for the spec's routes. Every failure is an ApiError with a typed `code`:
// "gone" (404), "network" (no answer or timeout), "server" (5xx), "limited" (429), "bad" (other 4xx).
import fs from "node:fs";
import { newId } from "../../core/src/index.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// User-Agent: grill-me-ai/<version>, plus " (<agent>)" when an agent name was resolved.
export const userAgent = (agent) => `grill-me-ai/${pkg.version}${agent ? ` (${agent})` : ""}`;

export class ApiError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const codeFor = (status) =>
  status === 404 ? "gone" : status === 429 ? "limited" : status >= 500 ? "server" : "bad";

async function request(server, method, path, { token, body, waitSeconds = 0, ok = [], agent, signal } = {}) {
  const timeoutMs = (waitSeconds + 15) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetch(`${server}${path}`, {
      method,
      signal: signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal,
      headers: {
        "user-agent": userAgent(agent),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Fetch resolves at headers. The same timeout/signal must cover a stalled body too.
    text = await res.text();
  } catch (err) {
    throw new ApiError("network", `could not reach ${server}: ${err?.cause?.message || err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok && !ok.includes(res.status)) {
    throw new ApiError(codeFor(res.status), `${method} ${path} → ${res.status}: ${text.slice(0, 200)}`, {
      status: res.status,
    });
  }
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError("server", `${method} ${path} → ${res.status} with a non-JSON body`);
    }
  }
  return { status: res.status, json };
}

// POST /api/g. The agent picks the id; on 409 it seals again under a fresh id, up to `tries` times.
// sealForId(id) → { secret, ct, iv, writeHash }. `qb` is the question-count bucket (daily metrics).
export async function createGrill(server, sealForId, { tries = 3, qb, agent } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const id = newId();
    const { secret, ct, iv, writeHash } = await sealForId(id);
    const res = await request(server, "POST", "/api/g", { body: { id, ct, iv, writeHash, ...(qb ? { qb } : {}) }, ok: [409], agent });
    if (res.status === 201) return { id, secret, expiresAt: res.json?.expiresAt };
  }
  throw new ApiError("server", `the server rejected ${tries} fresh ids; try again`);
}

// GET /api/g/:id → { ct, iv, answered, expiresAt }
export async function getGrill(server, id, { agent } = {}) {
  return (await request(server, "GET", `/api/g/${id}`, { agent })).json;
}

// GET /api/g/:id/answers?wait=N → { status: 200, answers: {ct, iv} } or { status: 204 }.
export async function waitAnswers(server, id, seconds, { agent, signal } = {}) {
  return request(server, "GET", `/api/g/${id}/answers?wait=${seconds}`, { waitSeconds: seconds, agent, signal });
}

// DELETE /api/g/:id. 204 on success; 404 throws a "gone" ApiError (callers treat it as success).
export async function deleteGrill(server, id, token, { agent, signal } = {}) {
  return request(server, "DELETE", `/api/g/${id}`, { token, agent, signal });
}

// ── Persistent interview sessions (protocol v2, /api/s). Every authenticated call takes
// the session's v2 write token; snapshots are the unauthenticated GET below. All functions
// return the raw { status, json } so callers can implement the exact-retry semantics.

// POST /api/s → 201 snapshot; an exact retry of the current operation answers 200.
export async function createSession(server, body, { agent, signal } = {}) {
  return request(server, "POST", "/api/s", { body, ok: [409], agent, signal });
}

// GET /api/s/:id?after=<revision>&wait=<0..50> → 200 snapshot, 204 unchanged, 404 ended.
export async function getSessionSnapshot(server, id, { after, waitSeconds = 0, agent, signal } = {}) {
  const query = `${after !== undefined ? `after=${after}&` : ""}wait=${waitSeconds}`;
  return request(server, "GET", `/api/s/${id}?${query}`, { waitSeconds, ok: [204, 404], agent, signal });
}

// POST /api/s/:id/rounds → 201 from idle, 200 exact retry, 409 otherwise.
export async function publishRound(server, id, token, body, { agent, signal } = {}) {
  return request(server, "POST", `/api/s/${id}/rounds`, { token, body, ok: [409], agent, signal });
}

// GET /api/s/:id/rounds/:round/answers?wait=N → 200 blob, 204 pending/idle, 409 other round, 404 ended.
export async function waitRoundAnswers(server, id, round, seconds, { agent, signal } = {}) {
  return request(server, "GET", `/api/s/${id}/rounds/${round}/answers?wait=${seconds}`, {
    waitSeconds: seconds,
    ok: [204, 409, 404],
    agent,
    signal,
  });
}

// POST /api/s/:id/rounds/:round/ack {expectedRevision, submissionId} → 204 (also a no-op for an
// already-acked or superseded round), 409 on a wrong current submission/version.
export async function ackRound(server, id, round, token, body, { agent, signal } = {}) {
  return request(server, "POST", `/api/s/${id}/rounds/${round}/ack`, { token, body, ok: [409], agent, signal });
}

// POST /api/s/:id/finish {expectedRevision} → 204 only for idle with the exact revision, else 409.
export async function finishSession(server, id, token, body, { agent, signal } = {}) {
  return request(server, "POST", `/api/s/${id}/finish`, { token, body, ok: [409], agent, signal });
}

// DELETE /api/s/:id — explicit cancel from any state; 404 throws "gone" like the legacy route.
export async function deleteSession(server, id, token, { agent, signal } = {}) {
  return request(server, "DELETE", `/api/s/${id}`, { token, agent, signal });
}
