// The install guide: wantsMarkdown, the /install, /llms.txt and negotiated / routes through the
// real server, and the nginx map giving the same answers as wantsMarkdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { wantsMarkdown, renderHomepage, INSTALL_MARKER, INSTALL_MD, LLMS_TXT } from "../src/install.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const CHROME_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const FIREFOX_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const SAFARI_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

// [label, accept, user-agent, markdown?] — shared by the wantsMarkdown test and the nginx map test.
const CASES = [
  ["chrome navigation", CHROME_ACCEPT, CHROME_UA, false],
  ["firefox navigation", FIREFOX_ACCEPT, FIREFOX_UA, false],
  ["safari navigation", SAFARI_ACCEPT, SAFARI_UA, false],
  ["*/*", "*/*", "node", true],
  ["no accept", undefined, "node", true],
  ["text/markdown", "text/markdown", "node", true],
  ["text/markdown preferred", "text/markdown, text/html;q=0.9", "node", true],
  ["text/plain", "text/plain", "node", true],
  ["curl", "*/*", "curl/8.5.0", true],
  ["curl with a browser accept", CHROME_ACCEPT, "curl/8.5.0", true],
  ["wget", "*/*", "Wget/1.21.4", true],
  ["wget with a browser accept", CHROME_ACCEPT, "Wget/1.21.4", true],
];

test("wantsMarkdown: the negotiation rule", () => {
  for (const [label, accept, ua, expected] of CASES)
    assert.equal(wantsMarkdown(accept, ua), expected, label);
});

test("renderHomepage keeps $-sequences in the guide literal", () => {
  // String.replace would read $&, $' and $1 as patterns; the replacer function must not.
  const html = renderHomepage(`<body>${INSTALL_MARKER}</body>`, "Cost: `$&` and $' and $1\n");
  assert.equal(html, "<body><p>Cost: <code>$&amp;</code> and $' and $1</p></body>");
});

test("renderHomepage renders CRLF headings, paragraphs and commands like LF", async () => {
  const md = (await readFile(INSTALL_MD, "utf8")).replace(/\r\n/g, "\n");
  const template = `<body>${INSTALL_MARKER}</body>`;
  const lf = renderHomepage(template, md);
  const crlf = renderHomepage(template, md.replace(/\n/g, "\r\n"));
  assert.equal(crlf, lf);
  assert.ok(crlf.includes("<h3>Install Grill Me</h3>"));
  assert.ok(crlf.includes("<h4>Codex in VS Code or another IDE</h4>"));
  assert.ok(crlf.includes('<pre><code>claude plugin marketplace add hoodoos/grill-me\n'));
  assert.ok(!crlf.includes("\r"), "rendered commands contain no carriage returns");
});

async function start() {
  const { server, close } = createServer({ db: ":memory:" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close };
}

// Raw requests, so headers can be left out entirely (fetch always sends an Accept).
const raw = (base, p, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(base + p, { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });

test("/ with content negotiation: body, content type and Vary", async () => {
  const { base, close } = await start();
  try {
    const guide = await readFile(INSTALL_MD, "utf8");
    for (const [label, accept, ua, markdown] of CASES) {
      const headers = {};
      if (accept !== undefined) headers.accept = accept;
      if (ua !== undefined) headers["user-agent"] = ua;
      const r = await raw(base, "/", headers);
      assert.equal(r.status, 200, label);
      assert.equal(r.headers.vary, "Accept, User-Agent", label);
      if (markdown) {
        assert.equal(r.headers["content-type"], "text/plain; charset=utf-8", label);
        assert.equal(r.body, guide, label);
      } else {
        assert.match(r.headers["content-type"], /^text\/html/, label);
        assert.match(r.body, /<!doctype html>/i, label);
        assert.equal(r.headers["x-content-type-options"], "nosniff", label);
        assert.match(r.headers["content-security-policy"], /script-src 'self'; style-src 'self'/, label);
        assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/, label);
      }
    }
  } finally {
    await close();
  }
});

test("/install: exact bytes and headers, no scripts", async () => {
  const { base, close } = await start();
  try {
    const r = await raw(base, "/install", { accept: "*/*" });
    assert.equal(r.status, 200);
    assert.equal(r.body, await readFile(INSTALL_MD, "utf8"));
    assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(r.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "public, max-age=300");
    assert.ok(!r.body.toLowerCase().includes("<script"), "no <script anywhere");
  } finally {
    await close();
  }
});

test("/llms.txt: the llms.txt file as text/plain", async () => {
  const { base, close } = await start();
  try {
    const r = await raw(base, "/llms.txt", { accept: "*/*" });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(r.body, await readFile(LLMS_TXT, "utf8"));
  } finally {
    await close();
  }
});

const unesc = (s) =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

test("the homepage carries the guide verbatim", async () => {
  const { base, close } = await start();
  try {
    const r = await raw(base, "/", { accept: CHROME_ACCEPT, "user-agent": CHROME_UA });
    assert.equal(r.status, 200);
    const html = r.body;
    assert.ok(
      html.includes('id="install-prompt" tabindex="0">Install Grill Me from https://grill-me.ai/</code>'),
      "the owner's copy-to-install prompt, verbatim",
    );
    assert.ok(html.includes('<link rel="alternate" type="text/markdown" href="/install">'), "rel=alternate");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline script");
    assert.match(html, /<script type="module" src="\/home-demo\.js\?v=[^"]+"><\/script>/);

    // Every command line from site/install.md's fenced blocks is inside a <pre><code> exactly once.
    const md = await readFile(INSTALL_MD, "utf8");
    const commands = [];
    let fence = null;
    for (const line of md.split("\n")) {
      if (line.startsWith("```")) { fence = fence ? null : []; continue; }
      if (fence && line.trim()) commands.push(line);
    }
    assert.ok(commands.length > 0, "sanity: the guide has commands");
    const blocks = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => unesc(m[1]));
    assert.ok(blocks.length > 0, "the homepage has code blocks");
    for (const cmd of commands)
      assert.equal(blocks.filter((b) => b.split("\n").includes(cmd)).length, 1, cmd);
  } finally {
    await close();
  }
});

// The nginx map is the production path: its regexes, extracted from the conf file, must give the
// same answers as wantsMarkdown.
test("the nginx map matches wantsMarkdown on the same cases", async () => {
  const conf = (await readFile(path.join(ROOT, "deploy/nginx/grill-me-http.conf"), "utf8")).replace(/\r\n/g, "\n");
  const m = /map "\$http_accept\|\$http_user_agent" \$grillme_markdown \{\n([\s\S]*?)^\}/m.exec(conf);
  assert.ok(m, "the $grillme_markdown map exists");
  const entries = [...m[1].matchAll(/(~\*?)(\S+)\s+(\d+);/g)].map((e) => ({
    re: new RegExp(e[2], e[1] === "~*" ? "i" : ""),
    val: Number(e[3]),
  }));
  assert.ok(entries.length >= 5, "sanity: extracted the map entries");
  const mapSays = (accept, ua) => {
    const s = `${accept ?? ""}|${ua ?? ""}`;
    for (const e of entries) if (e.re.test(s)) return e.val;
    return 0; // the map's `default 0`
  };
  for (const [label, accept, ua, expected] of CASES)
    assert.equal(mapSays(accept, ua), expected ? 1 : 0, label);
});
