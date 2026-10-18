// A manual test helper: posts a grill (default: the built-in demo), prints the link, long-polls
// for the answers, prints the decrypted lines and deletes the grill.
// Usage: node packages/server/scripts/try.mjs [--base http://127.0.0.1:8787] [file]
import { readFile } from "node:fs/promises";
import {
  convert, DEMO_TEXT, newId, newSecret, sealGrill, openAnswers,
  answerLines, makeLink, deriveKeys,
} from "../../core/src/index.js";

const args = process.argv.slice(2);
let base = "http://127.0.0.1:8787";
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base") base = args[++i];
  else rest.push(args[i]);
}

const raw = rest.length ? await readFile(rest[0], "utf8") : DEMO_TEXT;
let input = raw;
try { input = JSON.parse(raw); } catch {}
const c = convert(input);
if (!c.ok) { console.error("convert failed:", c.error); process.exit(1); }

const id = newId(), secret = newSecret();
const sealed = await sealGrill(c.grill, { id, secret });
const r = await fetch(`${base}/api/g`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id, ...sealed }),
});
if (r.status !== 201) { console.error(`create failed: HTTP ${r.status}`, await r.text()); process.exit(1); }
console.log(makeLink(id, secret, base));

for (;;) {
  const w = await fetch(`${base}/api/g/${id}/answers?wait=50`);
  if (w.status === 200) {
    const answers = await openAnswers(await w.json(), c.grill, { id, secret });
    console.log("\n" + answerLines(c.grill, answers));
    break;
  }
  if (w.status === 404) { console.error("grill expired"); process.exit(1); }
  // 204: nothing yet, ask again
}
await fetch(`${base}/api/g/${id}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${(await deriveKeys(secret)).writeToken}` },
});
console.log("grill deleted");
