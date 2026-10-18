import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes, access, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "../src/server.js";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "lib");
const DEPLOY = path.join(LIB, "..");
// bash (Git Bash) needs POSIX paths for globs; Windows temp paths like C:\… don't expand.
const toBash = (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
// Git Bash's default ln copies directories on Windows. Its emulated symlinks let the fixture
// exercise Linux-style link creation/readlink without Windows symlink privileges.
const shell = (...args) => promisify(execFile)("bash", args, { env: { ...process.env, MSYS: "winsymlinks" } });
const run = (script, ...args) => shell(toBash(path.join(LIB, script)), ...args.map(toBash));

let bash = true;
try { await promisify(execFile)("bash", ["--version"]); } catch { bash = false; }
let curl = true;
try { await promisify(execFile)("curl", ["--version"]); } catch { curl = false; }
const opts = { skip: !bash && "bash not available" };
let nodeTools = bash && curl;
if (nodeTools) {
  try { await shell("-c", "command -v tar xz sha256sum >/dev/null"); } catch { nodeTools = false; }
}
// macOS may have only shasum, rather than the GNU utility the Ubuntu deploy script uses.
// These tests always run on Linux CI and on the deploy host; do not fake the checksum tool.
const nodeOpts = { skip: !nodeTools && "Node archive fixtures need bash, curl, tar, xz and sha256sum" };

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
  // Old deployers left these newer non-site backups alongside site backups.
  await writeFile(`${bakNew}.snippet`, "old snippet without an include\n");
  await writeFile(`${bakNew}.http`, "old http config without an include\n");
  await utimes(bakOld, new Date("2026-10-01"), new Date("2026-10-01"));
  await utimes(bakNew, new Date("2026-10-02"), new Date("2026-10-02"));
  await run("restore-site.sh", site);
  assert.equal(await readFile(site, "utf8"), BEFORE);
});

async function fixtureDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function nodeDistribution(t, { executable = true, missing = false, version = "v24.1.0" } = {}) {
  const dir = await fixtureDir(t, "grill-me-node-");
  const dist = path.join(dir, "dist");
  await mkdir(dist);
  for (const arch of ["x64", "arm64"]) {
    const name = `node-v24.1.0-linux-${arch}`;
    const bin = path.join(dir, name, "bin");
    await mkdir(bin, { recursive: true });
    if (!missing) await writeFile(path.join(bin, "node"), `#!/usr/bin/env bash\necho ${version}\n`);
    // Set the mode in the actual tar header, including on Windows.
    await shell("-c", 'if [ -f "$2/$3/bin/node" ]; then chmod "$1" "$2/$3/bin/node"; fi; tar -cJf "$2/dist/$3.tar.xz" -C "$2" "$3"; cd "$2/dist"; sha256sum --text "$3.tar.xz" >> SHASUMS256.txt',
      "fixture", executable ? "755" : "644", toBash(dir), name);
  }
  return { dir, dist, opt: path.join(dir, "opt") };
}

for (const arch of ["x64", "arm64"]) {
  test(`install-node: official ${arch} archive layout, executable link, repeat without re-download`, nodeOpts, async (t) => {
    const { dist, opt } = await nodeDistribution(t);
    await run("install-node.sh", opt, arch, pathToFileURL(dist).href);
    const { stdout } = await shell("-c", 'readlink "$1/node"; "$1/node/bin/node" --version', "fixture", toBash(opt));
    assert.equal(stdout, `${toBash(opt)}/node-v24.1.0-linux-${arch}\nv24.1.0\n`);
    await rm(path.join(dist, `node-v24.1.0-linux-${arch}.tar.xz`));
    const again = await run("install-node.sh", opt, arch, pathToFileURL(dist).href);
    assert.match(again.stdout, /already current/);
  });
}

for (const [label, options] of [["missing binary", { missing: true }], ["not executable", { executable: false }], ["wrong version", { version: "v22.0.0" }]]) {
  test(`install-node: ${label} cannot replace the previous link`, nodeOpts, async (t) => {
    if (process.platform === "win32" && options.executable === false) return t.skip("Git Bash ignores POSIX execute bits; covered on Linux/macOS");
    const { dist, opt } = await nodeDistribution(t, options);
    await mkdir(path.join(opt, "previous"), { recursive: true });
    await shell("-c", 'ln -s "$1/previous" "$1/node"', "fixture", toBash(opt));
    await assert.rejects(run("install-node.sh", opt, "x64", pathToFileURL(dist).href), /not executable or reports the wrong version/);
    assert.equal((await shell("-c", 'readlink "$1/node"', "fixture", toBash(opt))).stdout, `${toBash(opt)}/previous\n`);
  });
}

async function nginxFixture(t, { present = true, site = BEFORE, patchFailure = false, valid = false } = {}) {
  const dir = await fixtureDir(t, "grill-me-nginx-");
  const release = path.join(dir, "release");
  await cp(DEPLOY, path.join(release, "deploy"), { recursive: true });
  if (patchFailure) await writeFile(path.join(release, "deploy/lib/patch-site.sh"), '#!/usr/bin/env bash\necho broken > "$1"\nexit 7\n');
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "nginx"), `#!/usr/bin/env bash\n[ "$1" = -t ] || exit 99\nprintf validated > "${toBash(dir)}/validated"\nexit ${valid ? 0 : 1}\n`);
  await shell("-c", 'chmod +x "$1/nginx"', "fixture", toBash(bin));
  const files = ["site", "snippet", "http", "legacy"].map((n) => path.join(dir, n));
  const before = [Buffer.from(site), ...["snippet", "http", "legacy"].map((s) => present ? Buffer.from(`prior ${s}\n\n# retained bytes\n`) : null)];
  for (let i = 0; i < files.length; i++) if (before[i]) await writeFile(files[i], before[i]);
  const configure = () => shell("-c", 'PATH="$1:$PATH" bash "$2" "${@:3}"', "fixture", toBash(bin),
    toBash(path.join(LIB, "configure-nginx.sh")), toBash(release), ...files.map(toBash));
  const assertRestored = async () => {
    for (let i = 0; i < files.length; i++) {
      if (before[i]) assert.deepEqual(await readFile(files[i]), before[i], files[i]);
      else await assert.rejects(access(files[i]), { code: "ENOENT" });
    }
  };
  return { dir, files, configure, assertRestored };
}

for (const present of [true, false]) {
  test(`configure-nginx: failed nginx -t restores prior bytes and ${present ? "existing" : "absent first-install"} files`, opts, async (t) => {
    const f = await nginxFixture(t, { present });
    await assert.rejects(f.configure());
    await access(path.join(f.dir, "validated")); // We reached the validation, after real patching.
    await f.assertRestored();
  });
}

for (const [label, options] of [
  ["patch failure", { patchFailure: true }],
  ["no matching 443 block", { site: REDIRECT }],
  ["pre-existing duplicate includes", { site: BEFORE + INCLUDE + "\n" + INCLUDE + "\n" }],
]) {
  test(`configure-nginx: ${label} restores every file before validation`, opts, async (t) => {
    const f = await nginxFixture(t, options);
    await assert.rejects(f.configure());
    await assert.rejects(access(path.join(f.dir, "validated")), { code: "ENOENT" });
    await f.assertRestored();
  });
}

test("configure-nginx: valid config commits the real patch, snippet and http config, removes legacy", opts, async (t) => {
  const f = await nginxFixture(t, { valid: true });
  await f.configure();
  assert.match(await readFile(f.files[0], "utf8"), /include \/etc\/nginx\/snippets\/grill-me.ai-locations.conf;/);
  assert.deepEqual(await readFile(f.files[1]), await readFile(path.join(DEPLOY, "nginx/grill-me.ai-locations.conf")));
  assert.deepEqual(await readFile(f.files[2]), await readFile(path.join(DEPLOY, "nginx/grill-me-http.conf")));
  await assert.rejects(access(f.files[3]), { code: "ENOENT" });
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

test("deploy.sh treats a release as built only when .release-sha exists", async () => {
  const src = (await readFile(path.join(DEPLOY, "deploy.sh"), "utf8")).replace(/\r\n/g, "\n");
  assert.match(src, /if \[ ! -f "\$REL\/\.release-sha" \]; then/, "keys on .release-sha, not the folder");
  assert.match(src, /rm -rf "\$REL"/, "a half-built release is wiped and rebuilt");
});

// The real check.sh against the real Node server, so a live check that can't work (e.g. one
// still assuming / is always HTML) fails here instead of on the production deploy.
test("check.sh passes against a real local server", async (t) => {
  if (!bash || !curl) return t.skip("bash or curl not available");
  const token = "test-stats-token-0f8b1c2d3e4f5a6b7c8d9e0f"; // >= 32 chars turns /stats on
  const { server, close } = createServer({ db: ":memory:", statsToken: token });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => close());
  const port = server.address().port;

  // check-live.mjs with a short hold, through check.sh's CHECK_LIVE override.
  const dir = await mkdtemp(path.join(tmpdir(), "grill-me-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wrapper = path.join(dir, "check-live.mjs");
  const real = pathToFileURL(path.join(DEPLOY, "..", "packages", "server", "scripts", "check-live.mjs")).href;
  await writeFile(wrapper, `process.argv.push("--wait", "3");\nawait import(${JSON.stringify(real)});\n`);

  const env = {
    ...process.env,
    BASE: `http://127.0.0.1:${port}`,
    GRILL_ME_NODE: toBash(process.execPath),
    STATS_TOKEN: token,
    CHECK_LIVE: toBash(wrapper),
  };
  try {
    const { stdout } = await promisify(execFile)(
      "bash", [toBash(path.join(DEPLOY, "check.sh")), toBash(path.join(dir, "no-such-snapshot"))], { env });
    assert.match(stdout, /ALL CHECKS PASSED/);
  } catch (e) {
    assert.fail(`check.sh failed:\n${e.stdout}\n${e.stderr}`);
  }
});
