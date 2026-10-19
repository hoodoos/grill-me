// Opt-in integration: real nginx, its installed mime.types, shipped map/locations, real
// Node backend and the entire real check.sh/check-live (default 50s hold for every case).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, access, chmod, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";

const ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const exec = promisify(execFile);
const TOKEN = "local-nginx-mime-test-token-0123456789abcdef";
const enabled = process.platform === "linux" && process.env.GRILL_ME_NGINX_TEST === "1";
const CASES = [
  { name: "application", type: "application/javascript", valid: true },
  { name: "text", type: "text/javascript", valid: true },
  { name: "application-params-case", type: "ApPlIcAtIoN/JaVaScRiPt ; charset=utf-8", valid: true },
  { name: "text-params-case", type: "TeXt/JaVaScRiPt; charset=utf-8", valid: true },
  ...["text/html", "text/plain", "application/octet-stream", "xapplication/javascript", "application/javascriptx", "xtext/javascript", "text/javascriptx"].map((type, i) => ({ name: `invalid-${i}`, type })),
  { name: "long-invalid", type: `application/javascript${"x".repeat(600)}` },
  { name: "combined-params", type: "text/javascript;charset=utf-8, text/html" },
  { name: "duplicate-params", type: "text/javascript;charset=utf-8", duplicate: true },
  { name: "missing-security", type: "application/javascript", missingSecurity: true },
  { name: "wrong-status", type: "application/javascript", wrongStatus: true },
];

async function unusedPort(used) {
  for (;;) {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const port = s.address().port;
    await new Promise((r) => s.close(r));
    if (!used.has(port)) { used.add(port); return port; }
  }
}

test("real nginx: full check.sh/50s long-poll accepts two exact JS essences and rejects invalid/ambiguous types, status and missing security", {
  skip: !enabled && "requires local Linux nginx/mime.types and GRILL_ME_NGINX_TEST=1",
  timeout: 90000,
}, async (t) => {
  await access("/usr/sbin/nginx");
  const mimeTypes = await readFile("/etc/nginx/mime.types", "utf8");
  assert.match(mimeTypes, /application\/javascript\s+js;/);
  const prefix = await mkdtemp(path.join(tmpdir(), "grill-me-nginx-test-"));
  // A root nginx master drops its workers' UID. Only the fixture's public ancestor/static
  // tree needs traversal/read access; config/evidence files retain the caller's mask.
  await chmod(prefix, 0o755);
  let backend, nginx, exited;
  t.after(async () => {
    if (nginx && nginx.exitCode === null && nginx.signalCode === null) {
      nginx.kill("SIGQUIT");
      const timer = setTimeout(() => nginx.kill("SIGKILL"), 3000);
      await exited; clearTimeout(timer);
    }
    if (backend) await backend.close();
    await rm(prefix, { recursive: true, force: true });
  });
  const evidence = process.env.GRILL_ME_NGINX_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  backend = createServer({ db: ":memory:", statsToken: TOKEN });
  await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
  const backendPort = backend.server.address().port;
  await exec(process.execPath, [path.join(ROOT, "packages/server/scripts/build-static.mjs"), path.join(prefix, "static")]);
  await exec("bash", [path.join(ROOT, "deploy/lib/public-tree.sh"), path.join(prefix, "static")]);
  await copyFile(path.join(ROOT, "deploy/nginx/grill-me-http.conf"), path.join(prefix, "http.conf"));
  const shipped = (await readFile(path.join(ROOT, "deploy/nginx/grill-me.ai-locations.conf"), "utf8"))
    .replaceAll("127.0.0.1:8787", `127.0.0.1:${backendPort}`)
    .replaceAll("/var/log/nginx/grill-me.ai.access.log", `${prefix}/access.log`);
  const used = new Set([backendPort]);
  const servers = [];
  for (const c of CASES) {
    c.port = await unusedPort(used);
    await writeFile(path.join(prefix, `${c.name}.types`), mimeTypes.replace(/application\/javascript\s+js;/, `${JSON.stringify(c.type)} js;`));
    let snippet = shipped;
    if (c.missingSecurity) snippet = snippet.replace(/^\s*add_header Permissions-Policy .*\n/gm, "");
    if (c.duplicate) snippet = snippet.replaceAll("add_header X-Content-Type-Options", 'add_header Content-Type "text/html" always;\n    add_header X-Content-Type-Options');
    await writeFile(path.join(prefix, `${c.name}.locations`), snippet);
    const statusLocations = c.wrongStatus ? ["/ui/grill.js", "/core/index.js"].map((route) => `location = ${route} { default_type text/plain; return 403 "BODY-MUST-NOT-APPEAR-IN-CHECK-LOG"; }`).join("\n") : "";
    servers.push(`server {
      listen 127.0.0.1:${c.port}; server_name localhost;
      root ${prefix}/static;
      include ${prefix}/${c.name}.types;
      ${statusLocations}
      include ${prefix}/${c.name}.locations;
    }`);
  }
  const config = `pid ${prefix}/nginx.pid;
    error_log ${prefix}/error.log warn;
    events { worker_connections 2048; }
    http {
      default_type application/octet-stream;
      client_body_temp_path ${prefix}/client-body;
      proxy_temp_path ${prefix}/proxy;
      include ${prefix}/http.conf;
      ${servers.join("\n")}
    }`;
  const conf = path.join(prefix, "nginx.conf");
  await writeFile(conf, config);
  if (evidence) await writeFile(path.join(evidence, "matrix-nginx.conf"), config);
  const args = ["-p", `${prefix}/`, "-c", conf, "-e", path.join(prefix, "error.log")];
  await exec("/usr/sbin/nginx", [...args, "-t"]);
  nginx = spawn("/usr/sbin/nginx", [...args, "-g", "daemon off;"], { stdio: "ignore" });
  exited = new Promise((r) => nginx.once("exit", r));
  const firstBase = `http://127.0.0.1:${CASES[0].port}`;
  for (let i = 0; ; i++) {
    try { assert.equal((await fetch(`${firstBase}/healthz`)).status, 200); break; }
    catch (e) { if (i >= 30) throw e; await new Promise((r) => setTimeout(r, 30)); }
  }
  console.log("Actual nginx matrix ready; all 16 full checks run their unmodified default 50s live probe.");
  const results = await Promise.allSettled(CASES.map(async (c) => {
    const base = `http://127.0.0.1:${c.port}`;
    const response = await fetch(`${base}/ui/grill.js`);
    const observed = { status: response.status, headers: Object.fromEntries([
      "content-type", "content-security-policy", "referrer-policy", "x-content-type-options", "cross-origin-opener-policy", "permissions-policy",
    ].map((name) => [name, response.headers.get(name)])) };
    await response.arrayBuffer();
    let result;
    try {
      result = { code: 0, ...await exec("bash", [path.join(ROOT, "deploy/check.sh"), path.join(prefix, "no-production-snapshot")], {
        env: { ...process.env, BASE: base, GRILL_ME_NODE: process.execPath, STATS_TOKEN: TOKEN, CHECK_LIVE: path.join(ROOT, "packages/server/scripts/check-live.mjs") },
        timeout: 75000, maxBuffer: 100000,
      }) };
    } catch (e) {
      if (e.code !== 1) throw e;
      result = e;
    }
    if (evidence) {
      await writeFile(path.join(evidence, `${c.name}.check.log`), `${result.stdout}\n${result.stderr}`);
      await writeFile(path.join(evidence, `${c.name}.headers.json`), JSON.stringify(observed, null, 2));
    }
    assert.equal(result.code, c.valid ? 0 : 1, `${c.name}:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ok wait held \d+\.\ds, 204/);
    assert.match(result.stdout, /ok wait woken in [\d.]+s with the answers/);
    assert.match(result.stdout, /PASS long poll/);
    assert.match(result.stdout, /SKIP neighbour\/ports\/units checks/);
    assert.ok(!result.stdout.includes("BODY-MUST-NOT-APPEAR"));
    const failures = result.stdout.split("\n").filter((line) => line.startsWith("FAIL "));
    if (c.valid) assert.match(result.stdout, /ALL CHECKS PASSED/);
    else {
      assert.ok(failures.some((line) => line.includes("GET /ui/grill.js")), c.name);
      assert.ok(failures.some((line) => line.includes("GET /core/index.js")), c.name);
      for (const line of failures) {
        assert.match(line, /HTTP (?:200|403); Content-Type: /);
        assert.ok(line.split("Content-Type: ")[1].length <= 161, "observed Content-Type is bounded to 160 bytes plus closing paren");
      }
      if (c.missingSecurity) assert.ok(failures.some((line) => line.includes("missing permissions-policy")));
    }
    console.log(`PASS real nginx ${c.name}: ${c.valid ? "accepted" : "rejected"}; full real long-poll passed`);
  }));
  const failures = results.filter((r) => r.status === "rejected");
  assert.equal(failures.length, 0, failures.map((r) => r.reason.stack || r.reason).join("\n"));
});
