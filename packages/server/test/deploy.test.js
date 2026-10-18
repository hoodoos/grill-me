import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "lib");
const DEPLOY = path.join(LIB, "..");
// bash (Git Bash) needs POSIX paths for globs; Windows temp paths like C:\… don't expand.
const toBash = (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
const run = (script, ...args) => promisify(execFile)("bash", [toBash(path.join(LIB, script)), ...args.map(toBash)]);

let bash = true;
try { await promisify(execFile)("bash", ["--version"]); } catch { bash = false; }
const opts = { skip: !bash && "bash not available" };

// The "before" side of deploy/nginx/site-443.patch, with an access_log line to be commented out.
const BEFORE = `server {
    server_name grill-me.ai;
    root /var/www/grill-me.ai;
    index index.html;
    location / {
        try_files $uri $uri/ =404;
    }
    access_log /var/log/nginx/grill-me.ai.access.log;
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/grill-me.ai/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/grill-me.ai/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}
`;

// A certbot port-80 redirect block (with a nested if) for the same name.
const REDIRECT = `server {
    if ($host = grill-me.ai) {
        return 301 https://$host$request_uri;
    } # managed by Certbot
    listen 80;
    server_name grill-me.ai;
    return 404; # managed by Certbot
}
`;

// Split a site file into its server blocks (by brace depth), preserving bytes.
function blocks(text) {
  const lines = text.split("\n");
  const out = [];
  let cur = null, depth = 0;
  for (const line of lines) {
    if (cur === null && /^[ \t]*server[ \t]*\{/.test(line)) cur = [];
    if (cur !== null) {
      cur.push(line);
      for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      if (depth === 0) { out.push(cur.join("\n")); cur = null; }
    }
  }
  return out;
}
const is443 = (b) => /listen[ \t]+443[ \t]+ssl/.test(b);
const INCLUDE = "include /etc/nginx/snippets/grill-me.ai-locations.conf;";

async function patched(t, content) {
  const dir = await mkdtemp(path.join(tmpdir(), "grill-me-site-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "grill-me.ai");
  await writeFile(file, content);
  await run("patch-site.sh", file);
  return { file, text: await readFile(file, "utf8") };
}

test("patch-site: the patch-file's before side gets exactly one include in the 443 block", opts, async (t) => {
  const { text } = await patched(t, BEFORE);
  assert.equal(text.split("grill-me.ai-locations.conf").length - 1, 1, "exactly one include");
  const b443 = blocks(text).find(is443);
  assert.ok(b443.includes(INCLUDE));
  assert.ok(!/^[ \t]*location[ \t]+\/[ \t]*\{/m.test(b443), "no bare location / left");
  assert.ok(!/^[ \t]*access_log /m.test(b443), "access_log commented out");
  assert.ok(/# access_log \/var\/log\/nginx\/grill-me\.ai\.access\.log;/.test(b443), "the old line is kept as a comment");
});

for (const [label, content] of [
  ["80 block before 443", REDIRECT + BEFORE],
  ["80 block after 443", BEFORE + REDIRECT],
]) {
  test(`patch-site: certbot file with the redirect block (${label})`, opts, async (t) => {
    const { text } = await patched(t, content);
    assert.equal(text.split("grill-me.ai-locations.conf").length - 1, 1);
    const bs443 = blocks(text).filter(is443);
    assert.equal(bs443.length, 1);
    assert.ok(bs443[0].includes(INCLUDE));
    assert.ok(!/^[ \t]*location[ \t]+\/[ \t]*\{/m.test(bs443[0]));
    // The redirect block is byte-identical.
    const redirectAfter = blocks(text).find((b) => !is443(b));
    assert.equal(redirectAfter, blocks(REDIRECT)[0]);
  });
}

test("patch-site: an already-patched file stays byte-identical", opts, async (t) => {
  const { text: once } = await patched(t, BEFORE);
  const dir = await mkdtemp(path.join(tmpdir(), "grill-me-site-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "grill-me.ai");
  await writeFile(file, once);
  await run("patch-site.sh", file);
  assert.equal(await readFile(file, "utf8"), once);
});

test("restore-site: restores the newest backup WITHOUT the include", opts, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "grill-me-site-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const site = path.join(dir, "grill-me.ai");
  const { text: patchedText } = await patched(t, BEFORE);
  await writeFile(site, patchedText);
  // Newest backup already contains the include (a re-deploy); the older one is clean.
  const bakNew = `${site}.bak-20261002000000`, bakOld = `${site}.bak-20261001000000`;
  await writeFile(bakNew, patchedText);
  await writeFile(bakOld, BEFORE);
  await utimes(bakOld, new Date("2026-10-01"), new Date("2026-10-01"));
  await utimes(bakNew, new Date("2026-10-02"), new Date("2026-10-02"));
  await run("restore-site.sh", site);
  assert.equal(await readFile(site, "utf8"), BEFORE);
});

test("restore-site: without a clean backup, strips the include and puts location / back", opts, async (t) => {
  const { file, text: patchedText } = await patched(t, BEFORE);
  await run("restore-site.sh", file);
  const text = await readFile(file, "utf8");
  assert.ok(!text.includes("grill-me.ai-locations.conf"));
  const b443 = blocks(text).find(is443);
  assert.ok(/location[ \t]+\/[ \t]*\{[^}]*try_files \$uri \$uri\/ =404;[^}]*\}/.test(b443), "location / restored");
});

test("deploy.sh accepts a full 40-hex sha as the ref", async () => {
  const src = (await readFile(path.join(DEPLOY, "deploy.sh"), "utf8")).replace(/\r\n/g, "\n");
  assert.match(src, /\[\[ "\$REF" =~ \^\[0-9a-f\]\{40\}\$ \]\]/, "sha-shaped ref check");
  // A sha deploy fetches the exact commit instead of resolving a name with ls-remote.
  assert.match(src, /SHA=\$REF/);
  assert.match(src, /git -C "\$REL" fetch --quiet --depth 1 origin "\$SHA"/);
  // The final checks come from the release, not the operator's clone.
  assert.match(src, /bash "\$REL\/deploy\/check\.sh"/);
});
