// Persistent interview sessions (protocol v2): keys, round-scoped encryption and links.
// Web Crypto only (globalThis.crypto), browser-safe and dependency-free. This module has its
// own HKDF namespace and AAD layout; the legacy v1 derivation/AAD/vectors in crypto.js are
// untouched, and v1 blobs fail authentication here (and vice versa).
import { LIMITS, validateGrill, validateAnswers } from "./format.js";
import { b64urlDecode, b64urlEncode, isId, isSecret } from "./crypto.js";

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const utf8decode = new TextDecoder();

export const SESSION_PROTOCOL = 2;
export const MAX_ROUND = 2147483647;

// Round: positive integer, safe, at most 2147483647 (matches the relay's INTEGER columns).
export function validateRound(round) {
  return Number.isInteger(round) && round >= 1 && round <= MAX_ROUND;
}

// AAD, UTF-8 exactly `grill-me/session/v2:<id>:<round>:<slot>` with slot `grill` or `answers`.
export function sessionAad(id, round, slot) {
  if (!isId(id)) throw new Error("bad id");
  if (!validateRound(round)) throw new Error("bad round");
  if (slot !== "grill" && slot !== "answers") throw new Error("bad slot");
  return `grill-me/session/v2:${id}:${round}:${slot}`;
}

const checkIds = (ids) => {
  if (!ids || !isId(ids.id)) throw new Error("bad id");
  if (!isSecret(ids.secret)) throw new Error("bad secret");
  if (!validateRound(ids.round)) throw new Error("bad round");
};

// encKey (AES-GCM 256) + writeToken/writeHash from the 16-byte secret, HKDF-SHA256 with an
// empty salt, in the v2 namespace (`grill-me/v2/...`), same result shape as deriveKeys.
export async function deriveSessionKeys(secret) {
  const ikm = b64urlDecode(secret);
  if (ikm.length !== 16) throw new Error("bad secret");
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey", "deriveBits"]);
  const hkdf = (info) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(info) });
  const encKey = await subtle.deriveKey(hkdf("grill-me/v2/enc"), key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const tokenBytes = new Uint8Array(await subtle.deriveBits(hkdf("grill-me/v2/write"), key, 256));
  const writeHash = b64urlEncode(new Uint8Array(await subtle.digest("SHA-256", tokenBytes)));
  return { encKey, writeToken: b64urlEncode(tokenBytes), writeHash };
}

const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

const encryptRoundJson = async (encKey, ids, slot, value) => {
  const iv = random(12);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(sessionAad(ids.id, ids.round, slot)) },
    encKey,
    utf8.encode(JSON.stringify(value)),
  );
  return { ct: b64urlEncode(new Uint8Array(ct)), iv: b64urlEncode(iv) };
};

const decryptRoundJson = async (encKey, ids, slot, { ct, iv }) => {
  try {
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(iv), additionalData: utf8.encode(sessionAad(ids.id, ids.round, slot)) },
      encKey,
      b64urlDecode(ct),
    );
    return JSON.parse(utf8decode.decode(plain));
  } catch {
    throw new Error("decrypt failed");
  }
};

export async function sealRound(grill, ids) {
  checkIds(ids);
  const v = validateGrill(grill);
  if (!v.ok) throw new Error(`invalid grill: ${v.errors.join("; ")}`);
  const { encKey, writeHash } = await deriveSessionKeys(ids.secret);
  const blob = await encryptRoundJson(encKey, ids, "grill", v.grill);
  if (b64urlDecode(blob.ct).length > LIMITS.grillBytes) throw new Error(`grill exceeds ${LIMITS.grillBytes} bytes encrypted`);
  return { ...blob, writeHash };
}

export async function openRound(blob, ids) {
  checkIds(ids);
  const { encKey } = await deriveSessionKeys(ids.secret);
  const v = validateGrill(await decryptRoundJson(encKey, ids, "grill", blob));
  if (!v.ok) throw new Error(`invalid grill: ${v.errors.join("; ")}`);
  return v.grill;
}

export async function sealRoundAnswers(answers, grill, ids) {
  checkIds(ids);
  const v = validateAnswers(answers, grill);
  if (!v.ok) throw new Error(`invalid answers: ${v.errors.join("; ")}`);
  const { encKey } = await deriveSessionKeys(ids.secret);
  const blob = await encryptRoundJson(encKey, ids, "answers", v.answers);
  if (b64urlDecode(blob.ct).length > LIMITS.answersBytes) throw new Error(`answers exceeds ${LIMITS.answersBytes} bytes encrypted`);
  return blob;
}

export async function openRoundAnswers(blob, grill, ids) {
  checkIds(ids);
  const { encKey } = await deriveSessionKeys(ids.secret);
  const v = validateAnswers(await decryptRoundJson(encKey, ids, "answers", blob), grill);
  if (!v.ok) throw new Error(`invalid answers: ${v.errors.join("; ")}`);
  return v.answers;
}

// `/g/<id>?session=2#<secret>` — the query marks protocol v2 and survives fragment stripping.
export function makeSessionLink(id, secret, base = "https://grill-me.ai") {
  if (!isId(id)) throw new Error("bad id");
  if (!isSecret(secret)) throw new Error("bad secret");
  return `${base}/g/${id}?session=2#${secret}`;
}

export function parseSessionLink(url) {
  const m = /^(.*)\/g\/([A-Za-z0-9_-]{16})\?session=2#([A-Za-z0-9_-]{22})$/.exec(String(url ?? ""));
  if (!m || !isId(m[2]) || !isSecret(m[3])) return null;
  return { base: m[1], id: m[2], secret: m[3], session: SESSION_PROTOCOL };
}
