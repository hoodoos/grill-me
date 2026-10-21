// Public immutable renderer: no capability in its URI/body, no remote module graph.
import { buildSync } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
let cached;
export function appResource() {
  if (cached) return cached;
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const built = buildSync({ absWorkingDir: root, entryPoints: [fileURLToPath(new URL("../app-ui/index.js", import.meta.url))],
    bundle: true, write: false, minify: true, metafile: true, platform: "browser", target: "es2022", format: "iife", legalComments: "inline" });
  const script = built.outputFiles[0].text;
  // Ship the ACTUAL notices of every bundled dependency, including mixed-license
  // transition notices. Package manifest SPDX shorthand is not a substitute.
  const roots = new Set();
  for (const input of Object.keys(built.metafile.inputs)) {
    const absolute = path.resolve(root, input).replaceAll("\\", "/"), marker = "/node_modules/", at = absolute.lastIndexOf(marker);
    if (at < 0) continue;
    const parts = absolute.slice(at + marker.length).split("/");
    roots.add(absolute.slice(0, at + marker.length) + parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/"));
  }
  const notices = [...roots].sort().map(dir => {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const files = readdirSync(dir).filter(name => /^(?:licen[cs]e|notice|copying)(?:$|[.-])/i.test(name)).sort();
    if (!files.length) throw new Error("Bundled dependency notice missing");
    return { package: pkg.name, version: pkg.version, notices: files.map(name => ({ name, text: readFileSync(path.join(dir, name), "utf8") })) };
  });
  const css = ["../../ui/src/grill.css", "../public/style.css", "../public/recovery.css", "../app-ui/host.css"].map(p => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
  const text = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content"><style>${css}</style></head><body><main id="app-host"><section id="cards" hidden><div id="grill-root"></div></section><section id="compact" hidden><strong id="compact-title"></strong><p id="compact-copy"></p></section><section id="status" role="status">Waiting for the interview…</section><footer id="actions"><button id="retry" hidden>Retry</button><button id="expand" hidden>Full screen</button><button id="recovery-open" aria-label="Timeout &amp; resume" title="Timeout &amp; resume" hidden>Help</button></footer><dialog id="recovery-dialog" aria-labelledby="recovery-title"><h2 id="recovery-title">Timeout &amp; resume</h2><p id="recovery-help"></p><p id="recovery-expiry"></p><p id="recovery-state" role="status"></p><p><button id="resume-interview" type="button">Resume interview</button> <button id="copy-resume" type="button">Copy resume message</button> <button id="recovery-copy" type="button" hidden>Copy answers</button></p><pre id="recovery-manual" tabindex="0" hidden aria-label="Select and copy recovery text"></pre><button id="recovery-close" type="button">Back to interview</button></dialog></main><script type="application/json" id="third-party-notices">${JSON.stringify(notices).replaceAll("<", "\\u003c")}</script><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 24);
  cached = Object.freeze({ uri: `ui://grill-me/interview-${hash}.html`, mimeType: "text/html;profile=mcp-app", text,
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: false } } });
  return cached;
}
