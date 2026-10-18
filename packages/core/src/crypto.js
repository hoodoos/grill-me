// Keys, links and encryption. Web Crypto only (globalThis.crypto), so this runs in Node and browsers.
// All base64url is unpadded RFC 4648 §5.
import { LIMITS, validateGrill, validateAnswers } from "./format.js";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const utf8decode = new TextDecoder();

export function b64urlEncode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
    if (b !== undefined) out += B64[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
    if (c !== undefined) out += B64[c & 63];
  }
  return out;
}

// Strict decode: rejects bad characters, bad length and non-canonical trailing bits.
export function b64urlDecode(str) {
  if (typeof str !== "string" || !str.length || str.length % 4 === 1) throw new Error("bad base64url");
  const bytes = [];
  let acc = 0, bits = 0;
  for (const ch of str) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("bad base64url");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bits && (acc & ((1 << bits) - 1)) !== 0) throw new Error("bad base64url"); // non-canonical trailing bits
  return new Uint8Array(bytes);
}

const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const newSecret = () => b64urlEncode(random(16)); // 22 chars
export const newId = () => b64urlEncode(random(12)); // 16 chars

const canonical = (s, bytes) => {
  try {
    return typeof s === "string" && b64urlDecode(s).length === bytes && b64urlEncode(b64urlDecode(s)) === s;
  } catch {
    return false;
  }
};
export const isSecret = (s) => canonical(s, 16);
export const isId = (s) => canonical(s, 12);

// encKey (AES-GCM 256) + writeToken/writeHash from the 16-byte secret, HKDF-SHA256 with an empty salt.
export async function deriveKeys(secret) {
  const ikm = b64urlDecode(secret);
  if (ikm.length !== 16) throw new Error("bad secret");
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey", "deriveBits"]);
  const hkdf = (info) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(info) });
  const encKey = await subtle.deriveKey(hkdf("grill-me/v1/enc"), key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const tokenBytes = new Uint8Array(await subtle.deriveBits(hkdf("grill-me/v1/write"), key, 256));
  const writeHash = b64urlEncode(new Uint8Array(await subtle.digest("SHA-256", tokenBytes)));
  return { encKey, writeToken: b64urlEncode(tokenBytes), writeHash };
}

// writeHash for a base64url token string, or null if it isn't exactly 32 canonical bytes.
export async function hashWriteToken(token) {
  if (!canonical(token, 32)) return null;
  return b64urlEncode(new Uint8Array(await subtle.digest("SHA-256", b64urlDecode(token))));
}

export async function encryptJson(encKey, id, slot, value) {
  if (slot !== "grill" && slot !== "answers") throw new Error("bad slot");
  const iv = random(12);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(`${id}:${slot}`) },
    encKey,
    utf8.encode(JSON.stringify(value)),
  );
  return { ct: b64urlEncode(new Uint8Array(ct)), iv: b64urlEncode(iv) };
}

export async function decryptJson(encKey, id, slot, { ct, iv }) {
  if (slot !== "grill" && slot !== "answers") throw new Error("bad slot");
  try {
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(iv), additionalData: utf8.encode(`${id}:${slot}`) },
      encKey,
      b64urlDecode(ct),
    );
    return JSON.parse(utf8decode.decode(plain));
  } catch {
    throw new Error("decrypt failed");
  }
}

const seal = async (value, slot, limit, { id, secret }) => {
  const { encKey, writeToken, writeHash } = await deriveKeys(secret);
  const blob = await encryptJson(encKey, id, slot, value);
  if (b64urlDecode(blob.ct).length > limit) throw new Error(`${slot} exceeds ${limit} bytes encrypted`);
  return { ...blob, writeToken, writeHash };
};

const open = async ({ ct, iv }, slot, { id, secret }) => {
  const { encKey } = await deriveKeys(secret);
  return decryptJson(encKey, id, slot, { ct, iv });
};

export async function sealGrill(grill, ids) {
  const v = validateGrill(grill);
  if (!v.ok) throw new Error(`invalid grill: ${v.errors.join("; ")}`);
  const { ct, iv, writeHash } = await seal(v.grill, "grill", LIMITS.grillBytes, ids);
  return { ct, iv, writeHash };
}

export async function openGrill(blob, ids) {
  const v = validateGrill(await open(blob, "grill", ids));
  if (!v.ok) throw new Error(`invalid grill: ${v.errors.join("; ")}`);
  return v.grill;
}

export async function sealAnswers(answers, grill, ids) {
  const v = validateAnswers(answers, grill);
  if (!v.ok) throw new Error(`invalid answers: ${v.errors.join("; ")}`);
  const { ct, iv } = await seal(v.answers, "answers", LIMITS.answersBytes, ids);
  return { ct, iv };
}

export async function openAnswers(blob, grill, ids) {
  const v = validateAnswers(await open(blob, "answers", ids), grill);
  if (!v.ok) throw new Error(`invalid answers: ${v.errors.join("; ")}`);
  return v.answers;
}

// Same questions → same hash (the normalized grill stringifies canonically).
export async function contentHash(grill) {
  const v = validateGrill(grill);
  if (!v.ok) throw new Error(`invalid grill: ${v.errors.join("; ")}`);
  return b64urlEncode(new Uint8Array(await subtle.digest("SHA-256", utf8.encode(JSON.stringify(v.grill)))));
}

export function makeLink(id, secret, base = "https://grill-me.ai") {
  if (!isId(id)) throw new Error("bad id");
  if (!isSecret(secret)) throw new Error("bad secret");
  return `${base}/g/${id}#${secret}`;
}

export function parseLink(url) {
  const m = /^(.*)\/g\/([A-Za-z0-9_-]{16})#([A-Za-z0-9_-]{22})$/.exec(String(url ?? ""));
  if (!m || !isId(m[2]) || !isSecret(m[3])) return null;
  return { base: m[1], id: m[2], secret: m[3] };
}
