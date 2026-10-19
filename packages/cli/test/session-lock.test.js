import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { withRecordLock } from "../src/pending.js";

const id = "AAAAAAAAAAAAAAAA";
const moduleUrl = new URL("../src/pending.js", import.meta.url).href;
async function home(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grill-session-lock-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function child(t, dir, body) {
  const source = `import fs from 'node:fs/promises';import path from 'node:path';
    import {withRecordLock} from ${JSON.stringify(moduleUrl)};
    const home=${JSON.stringify(dir)},id=${JSON.stringify(id)};${body}`;
  const p = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  p.stderr.on("data", b => stderr += b);
  t.after(() => { if (p.exitCode === null) p.kill(); });
  return new Promise((resolve, reject) => {
    p.on("error", reject);
    p.on("exit", code => code === 0 ? resolve() : reject(new Error(`child ${code}: ${stderr}`)));
  });
}

test("two actual processes serialize read/modify/write without lost increments", { timeout: 10000 }, async t => {
  const dir = await home(t);
  const file = path.join(dir, "counter");
  await fs.writeFile(file, "0");
  const body = `for(let i=0;i<15;i++)await withRecordLock(home,id,{},async()=>{
    const file=path.join(home,'counter'), n=Number(await fs.readFile(file,'utf8'));
    await new Promise(r=>setTimeout(r,3)); await fs.writeFile(file,String(n+1));
  });`;
  await Promise.all([child(t, dir, body), child(t, dir, body)]);
  assert.equal(await fs.readFile(file, "utf8"), "30");
});

test("aged active owner cannot be stolen; waiting is bounded by monotonic deadline", async t => {
  const dir = await home(t);
  await withRecordLock(dir, id, {}, async () => {
    const locks = await fs.readdir(path.join(dir, "pending"));
    const old = new Date(Date.now() - 60000);
    for (const name of locks) await fs.utimes(path.join(dir, "pending", name), old, old);
    let entered = false;
    const begin = performance.now();
    await assert.rejects(withRecordLock(dir, id, { ready: () => performance.now() - begin < 80 }, async () => { entered = true; }), { code: "deadline" });
    assert.equal(entered, false);
    assert.ok(performance.now() - begin < 500);
  });
});

test("crashed actual process generation is recovered, callback exceptions propagate", async t => {
  const dir = await home(t);
  await child(t, dir, "await withRecordLock(home,id,{},async()=>process.exit(0));");
  let entered = false;
  await withRecordLock(dir, id, {}, async () => { entered = true; });
  assert.equal(entered, true);
  const error = new Error("callback failure");
  await assert.rejects(withRecordLock(dir, id, {}, async () => { throw error; }), e => e === error);
  assert.deepEqual(await fs.readdir(path.join(dir, "pending")), []);
});
