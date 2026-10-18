// Entry point: node packages/server/src/main.js
// PORT (8787), HOST (127.0.0.1), GRILL_ME_DB (./data/grill-me.db). Behind nginx in production.
import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DB = process.env.GRILL_ME_DB || "./data/grill-me.db";
if (DB !== ":memory:") mkdirSync(path.dirname(path.resolve(DB)), { recursive: true });

// The deployed commit: deploy.sh writes .release-sha into the release folder (the working
// directory in production); the env var is the fallback. /stats shows it as GRILL_ME_VERSION.
try {
  const sha = readFileSync(path.resolve(".release-sha"), "utf8").trim();
  if (sha) process.env.GRILL_ME_VERSION = sha;
} catch {}

const { server, close } = createServer({ db: DB, log: (line) => console.log(line) });

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`grill-me listening on http://${HOST}:${PORT} (db: ${DB})`);
});
