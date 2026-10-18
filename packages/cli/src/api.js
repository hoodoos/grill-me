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
  } catch (err) {
    throw new ApiError("network", `could not reach ${server}: ${err?.cause?.message || err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
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
export async function deleteGrill(server, id, token, { agent } = {}) {
  return request(server, "DELETE", `/api/g/${id}`, { token, agent });
}
