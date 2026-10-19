import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, chmod, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const LIB = path.join(ROOT, "deploy/lib");
const exec = promisify(execFile);
const linux = { skip: process.platform !== "linux" && "requires Linux permissions/GNU tools" };
const run = (name, args, options = {}) => exec("bash", [path.join(LIB, name), ...args], options);
const mode = async (file) => (await stat(file)).mode & 0o777;
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "grill-me-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("public-tree: restrictive modes/repeat repair preserves execute bits, secret siblings and physical symlink targets", linux, async (t) => {
  const dir = await fixture(t);
  const tree = path.join(dir, "release"), privateDir = path.join(dir, "private");
  await mkdir(tree, { mode: 0o700 });
  await mkdir(privateDir, { mode: 0o700 });
  const main = path.join(tree, "main.js"), executable = path.join(tree, "executable");
  const marker = path.join(tree, ".release-sha"), secret = path.join(privateDir, "env");
  await writeFile(main, "public", { mode: 0o600 });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(marker, "complete-marker\n", { mode: 0o600 });
  await writeFile(secret, "do-not-touch", { mode: 0o600 });
  await symlink(privateDir, path.join(tree, "workspace-link"));
  const secretBefore = await stat(secret), markerBefore = await stat(marker);
  for (let i = 0; i < 2; i++) {
    await run("public-tree.sh", [tree]);
    assert.equal(await mode(tree), 0o755);
    assert.equal(await mode(main), 0o644);
    assert.equal(await mode(executable), 0o755);
    assert.equal(await readFile(marker, "utf8"), "complete-marker\n");
    assert.equal((await stat(marker)).ino, markerBefore.ino);
    assert.equal((await stat(secret)).mode, secretBefore.mode);
    assert.equal((await stat(secret)).uid, secretBefore.uid);
    assert.equal(await mode(privateDir), 0o700);
    assert.equal(await readFile(secret, "utf8"), "do-not-touch");
    await chmod(tree, 0o700); await chmod(main, 0o600); // existing complete-077 repeat
  }
  await assert.rejects(run("public-tree.sh", [path.join(tree, "workspace-link")]), /not a physical public tree/);
});

test("install-node: already-selected malformed non-executable distribution is never repaired into executable", linux, async (t) => {
  const dir = await fixture(t), name = "node-v24.1.0-linux-x64";
  const opt = path.join(dir, "opt"), target = path.join(opt, name), dist = path.join(dir, "dist");
  await mkdir(path.join(target, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(dist);
  await writeFile(path.join(target, "bin/node"), "#!/bin/sh\necho v24.1.0\n", { mode: 0o600 });
  await symlink(target, path.join(opt, "node"));
  const archive = path.join(dist, `${name}.tar.xz`);
  await exec("tar", ["-cJf", archive, "-C", opt, name]);
  const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(path.join(dist, "SHASUMS256.txt"), `${hash}  ${name}.tar.xz\n`);
  await assert.rejects(run("install-node.sh", [opt, "x64", pathToFileURL(dist).href]), /not executable/);
  assert.equal(await mode(path.join(target, "bin/node")), 0o600);
});

async function diagnosticFixture(t, hanging = false) {
  const dir = await fixture(t), bin = path.join(dir, "bin"), envfile = path.join(dir, "env");
  await mkdir(bin);
  const token = "synthetic-stats-token-0123456789abcdefghijklmnopqrstuvwxyz";
  await writeFile(envfile, `STATS_TOKEN=${token}\nOTHER_SECRET=env-contents-must-not-appear\n`, { mode: 0o640 });
  const scripts = {
    systemctl: hanging ? "sleep 60" : 'printf "%s\\n" "$@" > "$DIAG_FIXTURE/show-args"; printf "ActiveState=failed\\nExecMainStatus=200\\n"',
    journalctl: hanging ? "sleep 60" : 'printf "%s\\n" "$@" > "$DIAG_FIXTURE/journal-args"; cat "$DIAG_FIXTURE/journal"',
  };
  for (const [name, body] of Object.entries(scripts)) await writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await writeFile(path.join(dir, "journal"), `${"X".repeat(12288 - 16)}${token}\n2026-10-18 node: POST /api/g/unused 500 1ms\n`);
  const since = "2026-10-18T15:00:00Z";
  const invoke = () => run("startup-diagnostics.sh", ["fixture.service", since, dir, dir, dir, dir, envfile], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DIAG_FIXTURE: dir }, timeout: 15000, maxBuffer: 100000,
  });
  return { dir, token, since, invoke };
}

test("startup diagnostics: allowlisted show, attempt-only journal and token redaction before byte boundary cap", linux, async (t) => {
  const f = await diagnosticFixture(t);
  const { stdout } = await f.invoke();
  assert.ok(!stdout.includes(f.token.slice(0, 12)), "a token crossing byte 12288 must not expose even its prefix");
  assert.ok(!stdout.includes("env-contents-must-not-appear"));
  assert.ok(!stdout.includes("POST /api/"));
  const journal = stdout.split("(last 30 entries, at most 12 KiB)\n")[1].split("-- selected path")[0];
  assert.ok(Buffer.byteLength(journal) <= 12288);
  assert.deepEqual((await readFile(path.join(f.dir, "show-args"), "utf8")).trim().split("\n"), [
    "show", "fixture.service", "--no-pager", "-p", "ActiveState", "-p", "SubState", "-p", "Result", "-p", "ExecMainCode", "-p", "ExecMainStatus",
  ]);
  const journalArgs = await readFile(path.join(f.dir, "journal-args"), "utf8");
  assert.ok(journalArgs.includes(`--since\n${f.since}\n-n\n30\n`));
});

test("startup diagnostics: stalled systemctl and journal are bounded and still reach path metadata", linux, async (t) => {
  const f = await diagnosticFixture(t, true);
  const start = Date.now();
  const { stdout } = await f.invoke();
  assert.ok(Date.now() - start < 12000);
  assert.match(stdout, /selected path owners\/modes/);
});

test("opt-in isolated systemd: fresh022, fresh077 and complete077 real Node/main, nginx reads, private data/env", {
  skip: !(process.platform === "linux" && process.getuid?.() === 0 && process.env.GRILL_ME_SYSTEMD_SMOKE === "1") && "local Linux root/systemd smoke requires GRILL_ME_SYSTEMD_SMOKE=1",
}, async () => {
  const { stdout } = await exec("bash", [path.join(ROOT, "deploy/test-support/startup-smoke.sh"), ROOT, process.execPath], { timeout: 120000, maxBuffer: 100000 });
  for (const label of ["fresh022", "fresh077", "complete077"]) assert.ok(stdout.includes(`PASS ${label}: real service health`));
});
