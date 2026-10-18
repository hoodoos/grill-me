// Builds the publishable layout (used for the npm tarball and, in milestone 4, staged into the
// Claude Desktop extension): the repo's packages/cli (bin + src, no tests), packages/core/src and
// packages/ui/src (when it exists) mirrored under packages/…, plus a generated root package.json,
// README.md and LICENSE. The layout keeps the repo's relative paths, so no import rewriting is
// needed. Run directly to also `npm pack` into packages/cli/dist/.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(cliDir, "..", "..");

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
};

// stage(outDir) → the staged directory. Pure file work; no npm involved.
export function stage(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });

  copyDir(path.join(cliDir, "bin"), path.join(outDir, "packages", "cli", "bin"));
  copyDir(path.join(cliDir, "src"), path.join(outDir, "packages", "cli", "src"));
  fs.copyFileSync(path.join(cliDir, "package.json"), path.join(outDir, "packages", "cli", "package.json"));
  copyDir(path.join(repoRoot, "packages", "core", "src"), path.join(outDir, "packages", "core", "src"));

  const uiSrc = path.join(repoRoot, "packages", "ui", "src");
  const hasUi = fs.existsSync(uiSrc);
  if (hasUi) copyDir(uiSrc, path.join(outDir, "packages", "ui", "src"));

  const cliPkg = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8"));
  const { directory, ...repository } = cliPkg.repository;
  const rootPkg = {
    name: cliPkg.name,
    version: cliPkg.version,
    description: cliPkg.description,
    license: cliPkg.license,
    type: cliPkg.type,
    engines: cliPkg.engines,
    bin: { "grill-me": "packages/cli/bin/grill-me.js" },
    exports: {
      ".": "./packages/cli/src/index.js",
      "./core": "./packages/core/src/index.js",
      ...(hasUi
        ? {
            "./ui": "./packages/ui/src/grill.js",
            "./ui/grill.css": "./packages/ui/src/grill.css",
          }
        : {}),
      "./package.json": "./package.json",
    },
    dependencies: cliPkg.dependencies,
    repository,
    homepage: cliPkg.homepage,
    keywords: cliPkg.keywords,
  };
  fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(rootPkg, null, 2) + "\n");

  fs.copyFileSync(path.join(repoRoot, "README.md"), path.join(outDir, "README.md"));
  fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(outDir, "LICENSE"));
  return outDir;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const outDir = stage(path.join(cliDir, "dist", "grill-me-ai"));
  const pack = spawnSync("npm", ["pack"], {
    cwd: outDir,
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  if (pack.status !== 0) {
    console.error("npm pack failed");
    process.exit(1);
  }
  console.log(path.join(outDir, pack.stdout.trim().split("\n").pop()));
}
