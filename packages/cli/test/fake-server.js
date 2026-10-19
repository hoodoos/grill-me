// A small in-memory implementation of the spec's API for tests: id format enforced, 409 on a
// duplicate id, the write token checked with core's hashWriteToken, long poll with an injectable
// short max wait, 404 after delete, and switches to fail the next N requests or expire a grill.
import http from "node:http";
import { isId, hashWriteToken } from "../../core/src/index.js";

const HOUR = 3600_000;

export async function startFakeServer({ maxWait = 0.2 } = {}) {
  const grills = new Map(); // id → { ct, iv, writeHash, ans, createdAt, expiresAt, qb }
  const waiters = new Map(); // id → Set<{ res, timer }>
  const requests = []; // every request: { method, path, userAgent }
  let failNextCount = 0;
  let conflictNextCount = 0;
  let intercept = () => false;
  let afterDelete = () => false;
  let failureStatus = 500;

  const gone = (g) => !g || g.expiresAt <= Date.now();

  const flush = (id) => {
    const set = waiters.get(id);
    if (!set) return;
    waiters.delete(id);
    const g = grills.get(id);
    for (const { res, timer } of set) {
      clearTimeout(timer);
      if (gone(g)) res.writeHead(404).end("gone");
      else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(g.ans));
    }
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error("bad json"));
        }
      });
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, obj ? { "content-type": "application/json" } : {});
      res.end(obj ? JSON.stringify(obj) : undefined);
    };
    try {
      const url = new URL(req.url, "http://fake");
      const parts = url.pathname.split("/").filter(Boolean);
      requests.push({ method: req.method, path: url.pathname, userAgent: req.headers["user-agent"] });
      if (await intercept(req, res)) return;
      if (failNextCount > 0) {
        failNextCount--;
        return send(failureStatus, { error: "injected failure" });
      }

      if (req.method === "POST" && url.pathname === "/api/g") {
        const body = await readBody(req);
        requests.at(-1).qb = body.qb;
        if (!isId(body.id)) return send(400, { error: "bad id" });
        if (conflictNextCount > 0) {
          conflictNextCount--;
          return send(409, { error: "id taken" });
        }
        if (grills.has(body.id) && !gone(grills.get(body.id))) return send(409, { error: "id taken" });
        const expiresAt = Date.now() + HOUR; // epoch milliseconds, the milestone-2 contract
        grills.set(body.id, { ct: body.ct, iv: body.iv, writeHash: body.writeHash, ans: null, createdAt: Date.now(), expiresAt });
        return send(201, { id: body.id, expiresAt });
      }

      const id = parts[0] === "api" && parts[1] === "g" ? parts[2] : null;
      if (!id || !isId(id)) return send(404, { error: "not found" });
      const g = grills.get(id);
      const token = (req.headers.authorization || "").replace(/^Bearer /, "");
      const authed = !!g && (await hashWriteToken(token)) === g.writeHash;

      if (req.method === "GET" && parts.length === 3) {
        if (gone(g)) return send(404, { error: "gone" });
        return send(200, { ct: g.ct, iv: g.iv, answered: !!g.ans, expiresAt: g.expiresAt });
      }
      if (req.method === "POST" && parts[3] === "answers") {
        if (gone(g)) return send(404, { error: "gone" });
        if (!authed) return send(401, { error: "bad token" });
        if (g.ans) return send(409, { error: "already answered" });
        const body = await readBody(req);
        g.ans = { ct: body.ct, iv: body.iv };
        g.expiresAt = Date.now() + HOUR; // the deadline moves to 1 h after the answers
        flush(id);
        return send(204);
      }
      if (req.method === "GET" && parts[3] === "answers") {
        if (gone(g)) return send(404, { error: "gone" });
        if (g.ans) return send(200, g.ans);
        const waitParam = Number(url.searchParams.get("wait")) || 0;
        g.waitParams = g.waitParams || [];
        g.waitParams.push(waitParam);
        const waitMs = Math.min(waitParam, maxWait) * 1000;
        if (waitMs <= 0) return send(204);
        let set = waiters.get(id);
        if (!set) waiters.set(id, (set = new Set()));
        const entry = { res, timer: null };
        entry.timer = setTimeout(() => {
          set.delete(entry);
          send(204);
        }, waitMs);
        set.add(entry);
        res.on("close", () => clearTimeout(entry.timer));
        return; // answered by flush() or the timer
      }
      if (req.method === "DELETE" && parts.length === 3) {
        if (gone(g)) return send(404, { error: "gone" });
        if (!authed) return send(401, { error: "bad token" });
        grills.delete(id);
        flush(id);
        if (await afterDelete(req, res)) return;
        return send(204);
      }
      return send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: String(err) });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    grill: (id) => grills.get(id),
    creates: () => requests.filter((r) => r.method === "POST" && r.path === "/api/g").length,
    requests: () => requests,
    waitParams: (id) => grills.get(id)?.waitParams ?? [],
    intercept: (handler) => { intercept = handler; },
    afterDelete: (handler) => { afterDelete = handler; },
    failNext: (n = 1, status = 500) => {
      failNextCount = n;
      failureStatus = status;
    },
    conflictNext: (n = 1) => {
      conflictNextCount = n;
    },
    expire: (id) => {
      const g = grills.get(id);
      if (g) {
        g.expiresAt = Date.now() - 1;
        flush(id);
      }
    },
    close: () =>
      new Promise((resolve) => {
        for (const set of waiters.values()) for (const { res, timer } of set) clearTimeout(timer);
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
