// MCP2.0 is per request, never selected by a remembered connection/handshake.
import { hostedServerInfo } from "./hosted-brand.js";
export const MODERN = "2026-07-28";
const PREFIX = "io.modelcontextprotocol/";
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
function headerValue(value) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  if (value.startsWith("=?base64?") && value.endsWith("?=")) {
    const encoded = value.slice(9, -2);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64")); } catch { return undefined; }
  }
  return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) ? value : undefined;
}
export function modernRequest(req, message, supported) {
  const meta = message.params?._meta, bodyVersion = meta?.[PREFIX + "protocolVersion"], headerVersion = req.headers["mcp-protocol-version"];
  const modern = bodyVersion !== undefined || headerVersion === MODERN;
  if (!modern) return { modern: false };
  const error = (code, text, data) => ({ modern: true, error: { code, message: text, ...(data ? { data } : {}) } });
  if (!object(meta) || typeof bodyVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(bodyVersion) || !object(meta[PREFIX + "clientCapabilities"])) return error(-32602, "Required per-request metadata missing or malformed");
  if (meta[PREFIX + "clientInfo"] !== undefined && (!object(meta[PREFIX + "clientInfo"]) || typeof meta[PREFIX + "clientInfo"].name !== "string" || typeof meta[PREFIX + "clientInfo"].version !== "string")) return error(-32602, "Invalid client metadata");
  if (headerVersion !== bodyVersion || !/^[\x21-\x7e]+$/.test(req.headers["mcp-method"] ?? "") || req.headers["mcp-method"] !== message.method ||
    (["tools/call", "resources/read", "prompts/get"].includes(message.method) && (req.headers["mcp-name"] === undefined || headerValue(req.headers["mcp-name"]) !== (message.method === "resources/read" ? message.params.uri : message.params.name))))
    return error(-32020, "Required protocol headers missing or mismatched");
  if (bodyVersion !== MODERN) return error(-32022, "Unsupported protocol version", { supported, requested: bodyVersion });
  return { modern: true };
}
export const modernResult = (result, version) => ({ ...result, resultType: "complete", _meta: { ...result._meta, [PREFIX + "serverInfo"]: hostedServerInfo(version) } });
