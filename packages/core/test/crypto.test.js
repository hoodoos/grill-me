import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hkdfSync, createHash, createDecipheriv, randomBytes } from "node:crypto";
import {
  b64urlEncode, b64urlDecode, newSecret, newId, isSecret, isId,
  deriveKeys, hashWriteToken, encryptJson, decryptJson,
  sealGrill, openGrill, sealAnswers, openAnswers, contentHash, makeLink, parseLink,
} from "../src/index.js";

const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/crypto-vectors.json", import.meta.url), "utf8"));

const grill = {
  v: 1,
  title: "G",
  questions: [
    { n: 1, title: "One", body: "", choices: [], recommend: { choice: null, why: "do it" }, multi: false },
    { n: 2, title: "Two", body: "", choices: [{ name: "A", detail: "" }, { name: "B", detail: "" }], recommend: null, multi: false },
  ],
};

test("vectors: writeToken and writeHash match node:crypto HKDF/SHA-256", async () => {
  const ikm = b64urlDecode(vectors.secret);
  assert.deepEqual([...ikm], Array.from({ length: 16 }, (_, i) => i)); // the bytes 0x00..0x0f
  const expectedToken = Buffer.from(hkdfSync("sha256", Buffer.from(ikm), Buffer.alloc(0), "grill-me/v1/write", 32));
  assert.equal(vectors.writeToken, expectedToken.toString("base64url"));
  assert.equal(vectors.writeHash, createHash("sha256").update(expectedToken).digest("base64url"));
  const keys = await deriveKeys(vectors.secret);
  assert.equal(keys.writeToken, vectors.writeToken);
  assert.equal(keys.writeHash, vectors.writeHash);
  assert.equal(await hashWriteToken(vectors.writeToken), vectors.writeHash);
});

test("vectors: a node:crypto blob decrypts, and our blob decrypts with node:crypto", async () => {
  const keys = await deriveKeys(vectors.secret);
  // Fixed-iv blob from the vectors file (made with node:crypto).
  assert.deepEqual(await decryptJson(keys.encKey, vectors.id, "grill", { ct: vectors.ct, iv: vectors.iv }), vectors.value);
  // The other way: our encryptJson output decrypts with createDecipheriv.
  const blob = await encryptJson(keys.encKey, vectors.id, "grill", vectors.value);
  const encKey = Buffer.from(hkdfSync("sha256", Buffer.from(b64urlDecode(vectors.secret)), Buffer.alloc(0), "grill-me/v1/enc", 32));
  const raw = b64urlDecode(blob.ct);
  const d = createDecipheriv("aes-256-gcm", encKey, Buffer.from(b64urlDecode(blob.iv)));
  d.setAAD(Buffer.from(`${vectors.id}:grill`, "utf8"));
  d.setAuthTag(Buffer.from(raw.subarray(raw.length - 16)));
  const plain = Buffer.concat([d.update(Buffer.from(raw.subarray(0, raw.length - 16))), d.final()]);
  assert.deepEqual(JSON.parse(plain.toString("utf8")), vectors.value);
});

test("seal/open round trips for grill and answers", async () => {
  const id = newId(), secret = newSecret();
  const sealed = await sealGrill(grill, { id, secret });
  assert.equal(sealed.writeHash.length, 43);
  assert.deepEqual(await openGrill(sealed, { id, secret }), grill);
  const answers = { v: 1, answers: [{ n: 1, kind: "agree" }, { n: 2, kind: "choice", choice: "B" }] };
  const sealedA = await sealAnswers(answers, grill, { id, secret });
  assert.deepEqual(await openAnswers(sealedA, grill, { id, secret }), answers);
});

test("wrong slot, id, secret or a flipped bit all fail", async () => {
  const id = newId(), secret = newSecret();
  const sealed = await sealGrill(grill, { id, secret });
  await assert.rejects(openAnswers(sealed, grill, { id, secret }), /decrypt failed/); // wrong slot
  await assert.rejects(openGrill(sealed, { id: newId(), secret }), /decrypt failed/); // wrong id
  await assert.rejects(openGrill(sealed, { id, secret: newSecret() }), /decrypt failed/); // wrong secret
  const raw = b64urlDecode(sealed.ct);
  raw[3] ^= 1; // flip one ciphertext bit
  await assert.rejects(openGrill({ ct: b64urlEncode(raw), iv: sealed.iv }, { id, secret }), /decrypt failed/);
  await assert.rejects(openGrill({ ct: "!!!", iv: sealed.iv }, { id, secret }), /decrypt failed/);
});

test("size limits on ciphertext", async () => {
  const id = newId(), secret = newSecret();
  const big = { questions: Array.from({ length: 6 }, (_, i) => ({ n: i + 1, title: `big ${i}`, body: "x".repeat(3900) })) };
  await assert.rejects(sealGrill(big, { id, secret }), /exceeds 20480 bytes/);
  const many = { questions: [{ n: 1, title: "a" }, { n: 2, title: "b" }, { n: 3, title: "c" }] };
  const bigAnswers = { answers: [1, 2, 3].map((n) => ({ n, kind: "own", text: "y".repeat(3900) })) };
  await assert.rejects(sealAnswers(bigAnswers, many, { id, secret }), /exceeds 8192 bytes/);
});

test("seal/open validate first", async () => {
  const id = newId(), secret = newSecret();
  await assert.rejects(sealGrill({ questions: [] }, { id, secret }), /invalid grill/);
  await assert.rejects(sealAnswers({ answers: [{ n: 9, kind: "skip" }] }, grill, { id, secret }), /invalid answers/);
  const tamperedValue = await encryptJson((await deriveKeys(secret)).encKey, id, "grill", { questions: [] });
  await assert.rejects(openGrill(tamperedValue, { id, secret }), /invalid grill/);
});

test("base64url edge cases", () => {
  for (const n of [1, 2, 3, 4, 12, 16, 32, 64]) {
    const bytes = randomBytes(n);
    assert.deepEqual([...b64urlDecode(b64urlEncode(bytes))], [...bytes]);
  }
  assert.equal(b64urlEncode(new Uint8Array([0xfb, 0xff, 0xfe])), "-__-");
  assert.throws(() => b64urlDecode(""), /bad base64url/);
  assert.throws(() => b64urlDecode("A"), /bad base64url/); // length % 4 === 1
  assert.throws(() => b64urlDecode("A$"), /bad base64url/); // bad character
  assert.throws(() => b64urlDecode("AB"), /bad base64url/); // non-canonical trailing bits
  assert.deepEqual([...b64urlDecode("AA")], [0]);
  assert.deepEqual([...b64urlDecode("AAA")], [0, 0]);
  assert.equal(b64urlDecode("AAAA").length, 3);
});

test("id/secret shapes and strict checks", () => {
  const secret = newSecret(), id = newId();
  assert.equal(secret.length, 22);
  assert.equal(id.length, 16);
  assert.ok(isSecret(secret) && isId(id));
  assert.ok(!isSecret(id) && !isId(secret));
  assert.ok(!isSecret(secret + "A") && !isSecret(secret.slice(1)));
  assert.ok(!isId(id.replace(id[0], id[0] === "A" ? "B" : "A") + "!"));
});

test("hashWriteToken rejects non-canonical tokens", async () => {
  assert.equal(await hashWriteToken("short"), null);
  assert.equal(await hashWriteToken(b64urlEncode(randomBytes(31))), null);
  assert.equal(await hashWriteToken(b64urlEncode(randomBytes(33))), null);
  assert.ok(await hashWriteToken(b64urlEncode(randomBytes(32))));
});

test("contentHash: same questions, same hash", async () => {
  const h1 = await contentHash(grill);
  const h2 = await contentHash({ title: "G", questions: [{ n: 1, title: "One", recommend: { why: "do it" } }, { n: 2, title: "Two", choices: ["A", "B"] }] });
  assert.equal(h1, h2);
  const h3 = await contentHash({ questions: [{ title: "Different" }] });
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 43);
});

test("makeLink/parseLink round trip, link stays short", () => {
  const id = newId(), secret = newSecret();
  const link = makeLink(id, secret);
  assert.ok(link.length <= 61, link);
  assert.deepEqual(parseLink(link), { base: "https://grill-me.ai", id, secret });
  assert.deepEqual(parseLink(makeLink(id, secret, "http://localhost:8080")), { base: "http://localhost:8080", id, secret });
  assert.equal(parseLink("https://grill-me.ai/g/short#nope"), null);
  assert.equal(parseLink("https://grill-me.ai/other/" + id + "#" + secret), null);
  assert.equal(parseLink(link + "?x=1"), null);
  assert.throws(() => makeLink("bad", secret), /bad id/);
  assert.throws(() => makeLink(id, "bad"), /bad secret/);
});

test("encryptJson rejects unknown slots", async () => {
  const keys = await deriveKeys(newSecret());
  await assert.rejects(encryptJson(keys.encKey, newId(), "cookie", {}), /bad slot/);
  await assert.rejects(decryptJson(keys.encKey, newId(), "cookie", { ct: "", iv: "" }), /bad slot/);
});

test("newId never starts with '-', and isId still accepts one that does", () => {
  for (let i = 0; i < 1000; i++) {
    const id = newId();
    assert.ok(isId(id));
    assert.ok(!id.startsWith("-"), id);
  }
  assert.ok(isId("-bcd1234_efgh-ij"), "the server and CLI still accept any valid id");
});
