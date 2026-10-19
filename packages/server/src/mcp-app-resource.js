// Public immutable renderer: no capability in its URI/body, no remote module graph.
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
let cached;
export function appResource() {
  if (cached) return cached;
  const script = buildSync({ entryPoints: [fileURLToPath(new URL("../app-ui/index.js", import.meta.url))],
    bundle: true, write: false, minify: true, platform: "browser", target: "es2022", format: "iife", legalComments: "none" }).outputFiles[0].text;
  const css = ["../../ui/src/grill.css", "../public/style.css", "../app-ui/host.css"].map(p => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
  const text = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content"><style>${css}</style></head><body><main id="app-host"><section id="cards" hidden><div id="grill-root"></div></section><section id="status" role="status">Waiting for the interview…</section><footer id="actions"><button id="retry" hidden>Retry</button><button id="expand" hidden>Full screen</button></footer></main><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 24);
  cached = Object.freeze({ uri: `ui://grill-me/interview-${hash}.html`, mimeType: "text/html;profile=mcp-app", text,
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: false } } });
  return cached;
}
