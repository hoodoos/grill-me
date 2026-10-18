// Entry point: node packages/server/src/main.js
// PORT (8787), HOST (127.0.0.1), GRILL_ME_DB (./data/grill-me.db). Behind nginx in production.
import path from "node:path";
import { mkdirSync } from "node:fs";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DB = process.env.GRILL_ME_DB || "./data/grill-me.db";
if (DB !== ":memory:") mkdirSync(path.dirname(path.resolve(DB)), { recursive: true });

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
