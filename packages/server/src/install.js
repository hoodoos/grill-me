// The agent install guide: one source (site/install.md), served raw at /install, rendered into
// the homepage, and picked by content negotiation on /. Everything here is shared by the Node
// server (renders at startup) and scripts/build-static.mjs (renders for the static tree), so the
// three can't drift apart.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "site");

export const INSTALL_MD = path.join(SITE_DIR, "install.md");
export const LLMS_TXT = path.join(SITE_DIR, "llms.txt");

// Where the rendered guide goes in public/index.html.
export const INSTALL_MARKER = "<!-- install guide (rendered from site/install.md) -->";

// The one rule for GET /, mirrored by the nginx map in deploy/nginx/grill-me-http.conf: markdown
// when the client asks for it, when it doesn't ask for HTML (agents, curl), or when it's curl/Wget.
export const wantsMarkdown = (accept, userAgent) => {
  const a = (accept ?? "").toLowerCase();
  const ua = userAgent ?? "";
  return a.includes("text/markdown") || !a.includes("text/html") || ua.startsWith("curl/") || ua.startsWith("Wget/");
};

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

// Renders only what site/install.md uses: # and ## headings (shifted under the homepage's own
// h2), paragraphs, inline code and fenced code blocks. Everything is HTML-escaped.
export function renderInstallHtml(md) {
  const out = [];
  let fence = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  for (const line of md.split("\n")) {
    if (fence) {
      if (line.startsWith("```")) {
        out.push(`<pre><code>${esc(fence.join("\n"))}\n</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (line.startsWith("```")) { flushPara(); fence = []; continue; }
    const h = /^(#{1,2}) +(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length + 2; // the homepage has its own h1/h2, so the guide nests below
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
    } else if (line.trim()) para.push(line.trim());
    else flushPara();
  }
  flushPara();
  return out.join("\n");
}

export function renderHomepage(template, md) {
  if (!template.includes(INSTALL_MARKER)) throw new Error(`index.html is missing ${INSTALL_MARKER}`);
  return template.replace(INSTALL_MARKER, renderInstallHtml(md));
}

// What the server serves at startup: the raw guide, llms.txt and the rendered homepage.
export function loadInstall(indexTemplatePath) {
  const guide = readFileSync(INSTALL_MD, "utf8");
  const llms = readFileSync(LLMS_TXT, "utf8");
  const homepage = renderHomepage(readFileSync(indexTemplatePath, "utf8"), guide);
  return { guide, llms, homepage };
}
