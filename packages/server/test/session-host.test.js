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

// Everything the 0.1 page loads that must stay byte-identical: the legacy app, the shared UI
// (grill.js/state.js/text.js/grill.css — no CSS/gesture changes in 0.2.0) and the legacy core
// modules. core/index.js is exempt by design (it gains the v2 session exports for Node clients);
// browsers never import it here.
const LEGACY_FROZEN = [
  "packages/server/public/app.js",
  "packages/ui/src/grill.js",
  "packages/ui/src/state.js",
  "packages/ui/src/text.js",
  "packages/ui/src/grill.css",
  "packages/core/src/crypto.js",
  "packages/core/src/format.js",
  "packages/core/src/answers.js",
  "packages/core/src/convert.js",
  "packages/core/src/grill-text.js",
];

test("legacy modules the session page shares stay byte-identical to the pinned 0.1 base", { skip: !pinnedAvailable && "pinned base object unavailable (shallow clone)" }, () => {
  for (const p of LEGACY_FROZEN) {
    assert.equal(read(p), pinned(p), `${p} changed; the 0.2.0 phone side must not touch legacy bytes`);
  }
});

test("grill.html changes only cache URLs for the entry and standalone host style", { skip: !pinnedAvailable && "pinned base object unavailable" }, () => {
  const base = pinned("packages/server/public/grill.html").split("\n");
  const now = read("packages/server/public/grill.html").split("\n");
  assert.equal(base.length, now.length, "grill.html must not gain or lose lines");
  const diffs = base.map((l, i) => [l, now[i]]).filter(([a, b]) => a !== b);
  const styleVersion = createHash("sha256").update(read("packages/server/public/style.css")).digest("hex").slice(0, 12);
  assert.deepEqual(diffs, [[base.find(l => l.includes('/style.css?')), `<link rel="stylesheet" href="/style.css?v=${styleVersion}">`],
    ['<script type="module" src="/app.js"></script>', '<script type="module" src="/entry-020.js?v=terminal-1"></script>']],
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
    assert.match(html, /src="\/entry-020\.js\?v=terminal-1"/, "the grill page enters through the versioned entry");
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/, "strict CSP intact");

    for (const [p, name] of [["/entry-020.js?v=terminal-1", "entry"], ["/session-app.js?v=terminal-1", "session app"], ["/core/session.js", "session crypto"]]) {
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
