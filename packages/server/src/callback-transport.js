// Callback URLs/secrets/errors must never be logged. No fetch/proxy/redirect fallback.
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";
import crypto from "node:crypto";

export class CallbackError extends Error {
  constructor(reason) { super("Callback unavailable"); this.reason = reason; }
}
const bad = reason => { throw new CallbackError(reason); };
export function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (family !== 6 || address.includes("%") || address.includes(".")) return false;
  // Permit global unicast only. This also excludes mapped/compatible/ULA/link-local,
  // multicast and NAT64. Reject transition/special/documentation blocks conservatively.
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const first = parseInt(normalized.split(":")[0], 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff || first === 0x2002) return false;
  if (first === 0x2001) {
    const second = parseInt(normalized.split(":")[1] || "0", 16);
    if (second < 0x200 || second === 0xdb8) return false;
  }
  return !(first >= 0x3ff0); // documentation3fff::/20, conservative reserved vicinity
}
export function callbackUrl(value) {
  if (typeof value !== "string" || value.length > 2048) bad("invalid_url");
  let url; try { url = new URL(value); } catch { bad("invalid_url"); }
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash) bad("invalid_url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host.endsWith(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) bad("blocked_address");
  if (net.isIP(host) && !publicAddress(host)) bad("blocked_address");
  return url;
}
export function signingKey(secret) {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) bad("invalid_secret");
  const value = secret.slice(6), key = Buffer.from(value, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) bad("invalid_secret");
  return key;
}
export function signWebhook(secret, id, timestamp, body) {
  return "v1," + crypto.createHmac("sha256", signingKey(secret)).update(`${id}.${timestamp}.`).update(body).digest("base64");
}
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export async function callbackPost(destination, { body, headers, signal, timeoutMs = 10_000 }, dependencies = {}) {
  const url = callbackUrl(destination), host = url.hostname.replace(/^\[|\]$/g, "");
  if (Buffer.byteLength(body) > 4096) bad("body_limit");
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) bad("timeout");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs); timer.unref();
  let abortDns;
  try {
    const addresses = await Promise.race([
      net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : (dependencies.resolve ?? dns.lookup)(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { abortDns = () => reject(new CallbackError("timeout")); controller.signal.addEventListener("abort", abortDns, { once: true }); }),
    ]);
    controller.signal.removeEventListener("abort", abortDns);
    if (!addresses.length || addresses.length > 32 || addresses.some(a => !publicAddress(a.address) || net.isIP(a.address) !== a.family)) bad("blocked_address");
    const pinned = addresses[0];
    return await new Promise((resolve, reject) => {
      let bytes = 0; const chunks = [];
      const request = (dependencies.request ?? https.request)(url, {
        method: "POST", agent: false, autoSelectFamily: false, family: pinned.family,
        servername: net.isIP(host) ? undefined : host, signal: controller.signal,
        lookup: (_host, _options, cb) => cb(null, pinned.address, pinned.family),
        headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, res => {
        res.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 8192) { request.destroy(); reject(new CallbackError("response_limit")); }
          else chunks.push(chunk);
        });
        res.once("error", () => reject(new CallbackError("network")));
        res.once("end", () => {
          if (res.statusCode >= 300 && res.statusCode < 400) return reject(new CallbackError("redirect"));
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      request.once("error", () => reject(new CallbackError(controller.signal.aborted ? "timeout" : "network")));
      request.end(body);
    });
  } catch (error) { throw error instanceof CallbackError ? error : new CallbackError("network"); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (abortDns) controller.signal.removeEventListener("abort", abortDns); }
}
