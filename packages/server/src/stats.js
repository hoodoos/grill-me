// Prints the daily counters: node packages/server/src/stats.js [db]
// Counters only — created, answered, deleted, expired — never IPs, content or grills.
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2] || "./data/grill-me.db";
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare("SELECT day, name, count FROM stats ORDER BY day, name").all();
db.close();

if (!rows.length) {
  console.log("no stats yet");
  process.exit(0);
}
const w = Math.max(...rows.map((r) => r.name.length));
let day = null;
for (const r of rows) {
  if (r.day !== day) { day = r.day; console.log(day); }
  console.log(`  ${r.name.padEnd(w)}  ${r.count}`);
}
