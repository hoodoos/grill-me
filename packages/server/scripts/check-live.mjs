// The automated long-poll check, used by deploy/check.sh and runnable against a local server:
// creates a real grill with core, verifies one ?wait holds the full time and ends 204 (not 502
// or 504), that a second wait is woken within 2 s by a posted answer set, then DELETEs and
// expects 404.
// Usage: node packages/server/scripts/check-live.mjs <base> [--wait 50]
import {
  convert, DEMO_TEXT, newId, newSecret, sealGrill, sealAnswers, openAnswers, deriveKeys,
} from "../../core/src/index.js";

const args = process.argv.slice(2);
let base = null, waitS = 50;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--wait") waitS = Number(args[++i]);
  else base = args[i];
}
if (!base) {
  console.error("usage: node packages/server/scripts/check-live.mjs <base> [--wait 50]");
  process.exit(1);
}
base = base.replace(/\/$/, "");

const fail = (msg) => { console.error(`FAIL ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`ok ${msg}`);

const c = convert(DEMO_TEXT);
if (!c.ok) fail("convert(DEMO_TEXT)");
const id = newId(), secret = newSecret();
const ids = { id, secret };
const { writeToken } = await deriveKeys(secret);

const created = await fetch(`${base}/api/g`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id, ...(await sealGrill(c.grill, ids)) }),
});
if (created.status !== 201) fail(`create: HTTP ${created.status}`);
ok("create 201");

const got = await fetch(`${base}/api/g/${id}`);
if (got.status !== 200) fail(`get: HTTP ${got.status}`);
ok("get 200");

// One wait must hold at least wait-5 s and end 204 — not 502/504 from a proxy cutting it short.
const t0 = Date.now();
const w1 = await fetch(`${base}/api/g/${id}/answers?wait=${waitS}`);
const heldS = (Date.now() - t0) / 1000;
if (w1.status === 502 || w1.status === 504) fail(`wait: proxy cut the long poll (HTTP ${w1.status})`);
if (w1.status !== 204) fail(`wait: expected 204, got HTTP ${w1.status}`);
if (heldS < waitS - 5) fail(`wait: returned after ${heldS.toFixed(1)}s, expected to hold ~${waitS}s`);
ok(`wait held ${heldS.toFixed(1)}s, 204`);

// A second wait is woken within 2 s by a posted answer set.
const c2 = convert(DEMO_TEXT);
const answers = { v: 1, answers: c2.grill.questions.map((q) => ({ n: q.n, kind: "skip" })) };
const blob = await sealAnswers(answers, c.grill, ids);
const t1 = Date.now();
const w2p = fetch(`${base}/api/g/${id}/answers?wait=${waitS}`);
await new Promise((r) => setTimeout(r, 300));
const post = await fetch(`${base}/api/g/${id}/answers`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` },
  body: JSON.stringify(blob),
});
if (post.status !== 204) fail(`post answers: HTTP ${post.status}`);
const w2 = await w2p;
const wokeS = (Date.now() - t1) / 1000;
if (w2.status !== 200) fail(`woken wait: expected 200, got HTTP ${w2.status}`);
if (wokeS > 2) fail(`woken wait took ${wokeS.toFixed(1)}s, expected < 2s`);
await openAnswers(await w2.json(), c.grill, ids); // throws if undecryptable
ok(`wait woken in ${wokeS.toFixed(1)}s with the answers`);

const del = await fetch(`${base}/api/g/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${writeToken}` } });
if (del.status !== 204) fail(`delete: HTTP ${del.status}`);
ok("delete 204");

const gone = await fetch(`${base}/api/g/${id}`);
if (gone.status !== 404) fail(`after delete: expected 404, got HTTP ${gone.status}`);
ok("get after delete 404");

console.log("PASS long-poll check");
