// Builds dist/grill-me.mcpb, the Claude Desktop extension: the npm layout staged with pack.mjs
// into dist/mcpb/server/, plus node_modules/qrcode-generator, a server/index.js entry, the
// manifest (version stamped from packages/cli) and a generated icon. Then mcpb validate + pack.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stage } from "../packages/cli/scripts/pack.mjs";

const MCPB = "@anthropic-ai/mcpb@2.1.2"; // pinned build tool

const mcpbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(mcpbDir, "..");
const outDir = path.join(mcpbDir, "dist", "mcpb");
const tarball = path.join(mcpbDir, "dist", "grill-me.mcpb");

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(path.join(from, entry.name), path.join(to, entry.name));
    else fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
  }
};

// --- a tiny PNG icon (64×64): an orange flame-dot on a dark rounded square, no dependencies ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function makeIcon(size) {
  const s = (v) => (v * size) / 64; // the design is drawn on a 64×64 grid, scaled up
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const corner = Math.min(x, y, size - 1 - x, size - 1 - y);
      const round = corner < s(6) && Math.hypot(s(6) - Math.min(x, size - 1 - x), s(6) - Math.min(y, size - 1 - y)) > s(6);
      const flame = Math.hypot(x - size / 2, y - size / 2 - s(4)) < s(16); // the coal
      const core = Math.hypot(x - size / 2, y - size / 2 - s(4)) < s(8);
      px[o] = round ? 0 : core ? 255 : flame ? 255 : 26;
      px[o + 1] = round ? 0 : core ? 200 : flame ? 120 : 26;
      px[o + 2] = round ? 0 : core ? 60 : flame ? 20 : 30;
      px[o + 3] = round ? 0 : 255;
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- the build ---
fs.rmSync(path.join(mcpbDir, "dist"), { recursive: true, force: true });
stage(path.join(outDir, "server"));
copyDir(
  path.join(repoRoot, "node_modules", "qrcode-generator"),
  path.join(outDir, "server", "node_modules", "qrcode-generator"),
);
fs.writeFileSync(
  path.join(outDir, "server", "index.js"),
  `// The Claude Desktop extension entry: run the local MCP server over stdio.\n` +
    `import { startStdioServer } from "./packages/cli/src/mcp-stdio.js";\n\nawait startStdioServer();\n`,
);

const cliPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(mcpbDir, "manifest.json"), "utf8"));
manifest.version = cliPkg.version;
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(outDir, "icon.png"), makeIcon(512)); // Claude Desktop recommends 512×512

const npx = (args) => {
  const r = spawnSync("npx", ["-y", ...args], {
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`npx ${args.join(" ")} failed`);
    process.exit(1);
  }
  return r.stdout.trim();
};

npx([MCPB, "validate", path.join(outDir, "manifest.json")]);
npx([MCPB, "pack", outDir, tarball]);
console.log(tarball);
