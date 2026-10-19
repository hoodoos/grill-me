import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hkdfSync, createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  b64urlEncode, b64urlDecode, newSecret, newId,
  deriveKeys, sealGrill, openGrill, sealAnswers, makeLink, parseLink,
} from "../src/index.js";
import {
  SESSION_PROTOCOL, MAX_ROUND, validateRound, sessionAad,
  deriveSessionKeys, sealRound, openRound, sealRoundAnswers, openRoundAnswers,
  makeSessionLink, parseSessionLink,
} from "../src/session.js";

const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/crypto-vectors.json", import.meta.url), "utf8"));

const grill = {
  v: 1,
  title: "G",
  questions: [
    { n: 1, title: "One", body: "", choices: [], recommend: { choice: null, why: "do it" }, multi: false },
    { n: 2, title: "Two", body: "", choices: [{ name: "A", detail: "" }, { name: "B", detail: "" }], recommend: null, multi: false },
  ],
};
const ids = () => ({ id: newId(), secret: newSecret(), round: 1 });

test("v2 vectors: deriveSessionKeys matches node:crypto HKDF/SHA-256 in the v2 namespace", async () => {
  const ikm = Buffer.from(b64urlDecode(vectors.secret));
  const keys = await deriveSessionKeys(vectors.secret);
  const expectedToken = Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), "grill-me/v2/write", 32));
  assert.equal(keys.writeToken, expectedToken.toString("base64url"));
  assert.equal(keys.writeHash, createHash("sha256").update(expectedToken).digest("base64url"));
  // The v1 namespace must give different material from the same secret.
  const v1 = await deriveKeys(vectors.secret);
  assert.notEqual(keys.writeToken, v1.writeToken);
  assert.notEqual(keys.writeHash, v1.writeHash);
});

test("v2 AAD layout is exactly grill-me/session/v2:<id>:<round>:<slot>", () => {
  const { id } = ids();
  assert.equal(sessionAad(id, 7, "grill"), `grill-me/session/v2:${id}:7:grill`);
  assert.equal(sessionAad(id, 7, "answers"), `grill-me/session/v2:${id}:7:answers`);
  assert.throws(() => sessionAad(id, 7, "cookie"), /bad slot/);
  assert.throws(() => sessionAad("short", 7, "grill"), /bad id/);
  assert.throws(() => sessionAad(id, 0, "grill"), /bad round/);
});

test("v2 blobs interop with node:crypto using the round-scoped AAD", async () => {
  const { id, secret, round } = { ...ids(), round: 3 };
  const sealed = await sealRound(grill, { id, secret, round });
  const encKey = Buffer.from(hkdfSync("sha256", Buffer.from(b64urlDecode(secret)), Buffer.alloc(0), "grill-me/v2/enc", 32));
  const raw = b64urlDecode(sealed.ct);
  const d = createDecipheriv("aes-256-gcm", encKey, Buffer.from(b64urlDecode(sealed.iv)));
  d.setAAD(Buffer.from(`grill-me/session/v2:${id}:${round}:grill`, "utf8"));
  d.setAuthTag(Buffer.from(raw.subarray(raw.length - 16)));
  const plain = Buffer.concat([d.update(Buffer.from(raw.subarray(0, raw.length - 16))), d.final()]);
  assert.deepEqual(JSON.parse(plain.toString("utf8")), grill);
  // The other way: a node:crypto blob opens with openRoundAnswers.
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey, iv);
  c.setAAD(Buffer.from(`grill-me/session/v2:${id}:${round}:answers`, "utf8"));
  const answers = { v: 1, answers: [{ n: 1, kind: "agree" }, { n: 2, kind: "choice", choice: "B" }] };
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(answers), "utf8")), c.final()]);
  const opened = await openRoundAnswers(
    { ct: b64urlEncode(new Uint8Array([...ct, ...c.getAuthTag()])), iv: b64urlEncode(iv) },
    grill, { id, secret, round });
  assert.deepEqual(opened, answers);
});

test("seal/open round trips for round grill and answers", async () => {
  const { id, secret, round } = ids();
  const sealed = await sealRound(grill, { id, secret, round });
  assert.equal(sealed.writeHash.length, 43);
  assert.deepEqual(await openRound(sealed, { id, secret, round }), grill);
  const answers = { v: 1, answers: [{ n: 1, kind: "agree" }, { n: 2, kind: "choice", choice: "B" }] };
  const sealedA = await sealRoundAnswers(answers, grill, { id, secret, round });
  assert.deepEqual(await openRoundAnswers(sealedA, grill, { id, secret, round }), answers);
  // Fresh random IV per seal.
  const again = await sealRound(grill, { id, secret, round });
  assert.notEqual(again.ct, sealed.ct);
  assert.notEqual(again.iv, sealed.iv);
});

test("replays across ids, rounds, slots and legacy crypto all fail authentication", async () => {
  const { id, secret, round } = { ...ids(), round: 2 };
  const sealed = await sealRound(grill, { id, secret, round });
  await assert.rejects(openRound(sealed, { id: newId(), secret, round }), /decrypt failed/); // wrong id
  await assert.rejects(openRound(sealed, { id, secret, round: round + 1 }), /decrypt failed/); // wrong round
  await assert.rejects(openRound(sealed, { id, secret: newSecret(), round }), /decrypt failed/); // wrong secret
  await assert.rejects(openRoundAnswers(sealed, grill, { id, secret, round }), /decrypt failed/); // wrong slot
  const raw = b64urlDecode(sealed.ct);
  raw[3] ^= 1; // flip one ciphertext bit
  await assert.rejects(openRound({ ct: b64urlEncode(raw), iv: sealed.iv }, { id, secret, round }), /decrypt failed/);
  // Cross-protocol: a v1 blob fails under v2 keys/AAD and a v2 blob under v1.
  const v1 = await sealGrill(grill, { id, secret });
  await assert.rejects(openRound(v1, { id, secret, round }), /decrypt failed/);
  await assert.rejects(openGrill(sealed, { id, secret }), /decrypt failed/);
  const v1a = await sealAnswers({ v: 1, answers: [{ n: 1, kind: "agree" }, { n: 2, kind: "choice", choice: "B" }] }, grill, { id, secret });
  await assert.rejects(openRoundAnswers(v1a, grill, { id, secret, round }), /decrypt failed/);
});

test("round validation: positive safe integers up to 2147483647 only", async () => {
  assert.ok(validateRound(1) && validateRound(MAX_ROUND));
  for (const bad of [0, -1, 1.5, NaN, "2", null, undefined, MAX_ROUND + 1, Number.MAX_SAFE_INTEGER]) {
    assert.ok(!validateRound(bad), String(bad));
    await assert.rejects(sealRound(grill, { ...ids(), round: bad }), /bad round/);
    await assert.rejects(sealRoundAnswers({ v: 1, answers: [] }, grill, { ...ids(), round: bad }), /bad round/);
  }
});

test("seal/open validate first and enforce byte limits", async () => {
  const { id, secret, round } = ids();
  await assert.rejects(sealRound({ questions: [] }, { id, secret, round }), /invalid grill/);
  await assert.rejects(sealRoundAnswers({ answers: [{ n: 9, kind: "skip" }] }, grill, { id, secret, round }), /invalid answers/);
  const big = { questions: Array.from({ length: 6 }, (_, i) => ({ n: i + 1, title: `big ${i}`, body: "x".repeat(3900) })) };
  await assert.rejects(sealRound(big, { id, secret, round }), /exceeds 20480 bytes/);
  const many = { questions: [{ n: 1, title: "a" }, { n: 2, title: "b" }, { n: 3, title: "c" }] };
  const bigAnswers = { answers: [1, 2, 3].map((n) => ({ n, kind: "own", text: "y".repeat(3900) })) };
  await assert.rejects(sealRoundAnswers(bigAnswers, many, { id, secret, round }), /exceeds 8192 bytes/);
});

test("makeSessionLink/parseSessionLink carry the explicit ?session=2 marker", () => {
  const { id, secret } = ids();
  const link = makeSessionLink(id, secret);
  assert.equal(link, `https://grill-me.ai/g/${id}?session=2#${secret}`);
  assert.deepEqual(parseSessionLink(link), { base: "https://grill-me.ai", id, secret, session: SESSION_PROTOCOL });
  assert.deepEqual(parseSessionLink(makeSessionLink(id, secret, "http://localhost:8080")),
    { base: "http://localhost:8080", id, secret, session: SESSION_PROTOCOL });
  // Legacy links reject the marker, session links reject a missing/wrong one: no ambiguity.
  assert.equal(parseLink(link), null);
  assert.equal(parseSessionLink(makeLink(id, secret)), null);
  assert.equal(parseSessionLink(link.replace("?session=2", "?session=1")), null);
  assert.equal(parseSessionLink(link.replace("?session=2", "")), null);
  assert.equal(parseSessionLink(link + "?x=1"), null);
  assert.equal(parseSessionLink(`https://grill-me.ai/g/short?session=2#nope`), null);
  assert.throws(() => makeSessionLink("bad", secret), /bad id/);
  assert.throws(() => makeSessionLink(id, "bad"), /bad secret/);
});
