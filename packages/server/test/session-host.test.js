// Session-host invariants (protocol v2 phone side). These run anywhere `node --test` runs; the
// behavioral browser proofs live in session-host-browser.test.js.
import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PINNED_BASE = "d1fb2110565426ca450f57ea215cf92e7cd60b92"; // main the 0.2.0 extension starts from
const PUBLIC = path.join(ROOT, "packages", "server", "public");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const pinnedAvailable = (() => {
  try {
    execFileSync("git", ["-C", ROOT, "cat-file", "-e", PINNED_BASE], { stdio: "ignore" });
    return true;
  } catch {
    return false; // shallow clone without the pinned object: byte checks skip, nothing is faked
  }
})();
const pinned = (p) => execFileSync("git", ["-C", ROOT, "show", `${PINNED_BASE}:${p}`], { maxBuffer: 4 << 20 }).toString("utf8");

// Legacy crypto/format vectors, safe text and CSS remain frozen. The shared state/UI and
// phone adapters now intentionally fix gesture commits, multi-drafts and answer budgets;
// their changed module URLs must invalidate warm browser copies below.
const LEGACY_FROZEN = [
  "packages/ui/src/text.js",
  "packages/ui/src/grill.css",
  "packages/core/src/crypto.js",
  "packages/core/src/format.js",
  "packages/core/src/answers.js",
  "packages/core/src/convert.js",
  "packages/core/src/grill-text.js",
];

test("legacy crypto, format, safe text and CSS stay byte-identical to the pinned 0.1 base", { skip: !pinnedAvailable && "pinned base object unavailable (shallow clone)" }, () => {
  for (const p of LEGACY_FROZEN) {
    assert.equal(read(p), pinned(p), `${p} changed; the 0.2.0 phone side must not touch legacy bytes`);
  }
});

test("grill.html preserves legacy screens while isolating recovery controls and versioning changed modules", { skip: !pinnedAvailable && "pinned base object unavailable" }, () => {
  const base = pinned("packages/server/public/grill.html").split("\n");
  const html = read("packages/server/public/grill.html");
  assert.equal((html.match(/<dialog id="recovery-dialog"/g) || []).length, 1);
  assert.match(html, /Copy resume message/);
  assert.match(html, /recovery\.css\?v=resume-1/);
  const now = html.replace(/<link rel="stylesheet" href="\/recovery.css[^\n]+\n/, "")
    .replace(/    <p><button data-recovery[^\n]+\n/, "")
    .replaceAll('<button data-recovery type="button" hidden>Timeout &amp; resume</button>', "")
    .replace('</button> </p>', '</button></p>')
    .replace(/<dialog id="recovery-dialog"[^\n]+\n/, "").split("\n");
  assert.equal(base.length, now.length, "grill.html must not gain or lose lines");
  const diffs = base.map((l, i) => [l, now[i]]).filter(([a, b]) => a !== b);
  const styleVersion = createHash("sha256").update(read("packages/server/public/style.css")).digest("hex").slice(0, 12);
  const iconVersion = createHash("sha256").update(read("packages/server/public/favicon.svg")).digest("hex").slice(0, 12);
  assert.deepEqual(diffs, [[base.find(l => l.includes('rel="icon"')), `<link rel="icon" href="/favicon.svg?v=${iconVersion}" type="image/svg+xml">`],
    [base.find(l => l.includes('/style.css?')), `<link rel="stylesheet" href="/style.css?v=${styleVersion}">`],
    ['<script type="module" src="/app.js"></script>', '<script type="module" src="/entry-020.js?v=resume-1"></script>']],
    "only changed standalone assets gain cache versions; the shared CSS URL stays untouched");
});

test("the session page and its module graph are served with correct types", async () => {
  const { createServer } = await import("../src/server.js");
  const srv = createServer({ db: ":memory:", sweepMs: 60_000 });
  await new Promise((res) => srv.server.listen(0, "127.0.0.1", res));
  const origin = `http://127.0.0.1:${srv.server.address().port}`;
  const t = process.hrtime.bigint();
  const id = "AAAAAAAAAAAAAAAA"; // shape-valid id; content is never read by the page route
  try {
    const page = await fetch(`${origin}/g/${id}?session=2`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /src="\/entry-020\.js\?v=resume-1"/, "the grill page enters through the versioned entry");
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/, "strict CSP intact");

    for (const [p, name] of [["/core/recovery.js?v=resume-1", "recovery"], ["/entry-020.js?v=resume-1", "entry"], ["/session-app.js?v=resume-1", "session app"], ["/core/session.js", "session crypto"]]) {
      const r = await fetch(origin + p, { cache: "no-store" });
      assert.equal(r.status, 200, `${name} served`);
      assert.match(r.headers.get("content-type"), /text\/javascript/, `${name} served as a JS module`);
      assert.match(r.headers.get("cache-control"), /max-age=300/, `${name} carries the shared static cache policy`);
    }
    // The legacy modules are still served untouched for old clients.
    assert.equal((await fetch(origin + "/app.js", { cache: "no-store" })).status, 200);
    assert.equal((await fetch(origin + "/core/index.js", { cache: "no-store" })).status, 200);
  } finally {
    srv.closeAllConnections?.();
    await srv.close();
  }
  assert.ok(process.hrtime.bigint() - t > 0n);
});
