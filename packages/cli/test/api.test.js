import test from "node:test";
import assert from "node:assert/strict";
import { waitAnswers } from "../src/api.js";
import { startFakeServer } from "./fake-server.js";

test("HTTP attempt timeout remains armed through a stalled response body and reports a network error", { timeout: 3000 }, async (t) => {
  const fake = await startFakeServer();
  t.after(() => fake.close());
  let headersSent = false;
  fake.intercept((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    res.write('{"ct":');
    headersSent = true;
    return true;
  });
  // Shorten the normal 15-second HTTP-attempt timeout; keep the real fetch and real socket/body.
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => timeout(callback, ms === 15_000 ? 150 : ms, ...args));
  await assert.rejects(waitAnswers(fake.url, "Abcd1234_efgh-ij", 0), { code: "network" });
  assert.equal(headersSent, true, "headers arrived before the body timeout fired");
});
