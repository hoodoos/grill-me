// Prints the daily counters: node packages/server/src/stats.js [db]
// Counters and bucket counters only (created, opened, answered, picked_up, cancelled, expired_*,
// hub_click, time/size/question/agent/version buckets) — never IPs, content, ids or grills.
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2] || "./data/grill-me.db";
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare("SELECT day, name, bucket, count FROM stats ORDER BY day DESC, name, bucket").all();
db.close();

if (!rows.length) {
  console.log("no stats yet");
  process.exit(0);
}
const w = Math.max(...rows.map((r) => (r.bucket ? `${r.name}/${r.bucket}` : r.name).length));
let day = null;
for (const r of rows) {
  if (r.day !== day) { day = r.day; console.log(day); }
  const label = r.bucket ? `${r.name}/${r.bucket}` : r.name;
  console.log(`  ${label.padEnd(w)}  ${r.count}`);
}
