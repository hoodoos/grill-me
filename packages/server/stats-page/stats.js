// The /stats page: loads /stats/data.json and renders the funnel, bucket distributions and
// live health. Everything is built with textContent — the data is ours, but the habit is cheap.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const fmt = (n) => Number(n).toLocaleString("en");

// Pivot rows into byDay[day][name][bucket] = count.
function pivot(days) {
  const byDay = new Map();
  for (const { day, name, bucket, count } of days) {
    if (!byDay.has(day)) byDay.set(day, new Map());
    const m = byDay.get(day);
    if (!m.has(name)) m.set(name, new Map());
    m.get(name).set(bucket, count);
  }
  return byDay;
}
const get = (dayMap, day, name, bucket = "") => dayMap.get(day)?.get(name)?.get(bucket) || 0;
const total = (dayMap, name) => {
  let t = 0;
  for (const d of dayMap.values()) for (const c of d.get(name)?.values() || []) t += c;
  return t;
};
const bucketTotals = (dayMap, name) => {
  const t = new Map();
  for (const d of dayMap.values())
    for (const [b, c] of d.get(name)?.entries() || []) t.set(b, (t.get(b) || 0) + c);
  return t;
};

// The estimated median/p90 of a bucket distribution: the first bucket (in order) where the
// cumulative share crosses the percentile. Approximate by design.
function percentile(buckets, order, p) {
  const t = order.reduce((s, b) => s + (buckets.get(b) || 0), 0);
  if (!t) return null;
  let acc = 0;
  for (const b of order) {
    acc += buckets.get(b) || 0;
    if (acc / t >= p) return b;
  }
  return order[order.length - 1];
}

function bars(container, buckets, order) {
  const max = Math.max(1, ...order.map((b) => buckets.get(b) || 0));
  for (const b of order) {
    const c = buckets.get(b) || 0;
    const row = el("div", "brow");
    row.append(el("span", "blabel", b));
    const bar = el("span", "bar");
    bar.style.width = `${Math.round((c / max) * 100)}%`;
    row.append(bar, el("span", "bval", fmt(c)));
    container.append(row);
  }
}

function render(d) {
  const dayMap = pivot(d.days);
  $("generated").textContent =
    `v${d.version.package}${d.version.deploy ? " · " + d.version.deploy : ""} · up ${Math.floor(d.uptimeS / 60)} min · ` +
    `db ${(d.dbBytes / 1024).toFixed(0)} KB · generated ${new Date(d.generatedAt).toISOString()}`;

  // Live health
  const live = $("live");
  const memPct = d.memory.pct == null ? "unknown" : `${d.memory.pct}%`;
  live.append(
    card("Waiting requests", `${d.live.waiters} (max ${d.live.waitersMaxPerGrill} on one grill)`),
    card("Memory", `${(d.memory.rss / 1048576).toFixed(1)} MB RSS, ${(d.memory.heapUsed / 1048576).toFixed(1)} MB heap — ${memPct} of cap`),
    card("DB size", `${(d.dbBytes / 1024).toFixed(0)} KB`),
  );
  const mins = d.live.minutes;
  const maxReq = Math.max(1, ...mins.map((m) => m.requests));
  const minEl = $("minutes");
  for (const m of mins) {
    const row = el("div", "brow");
    row.append(el("span", "blabel", new Date(m.minute).toISOString().slice(11, 16)));
    const bar = el("span", "bar");
    bar.style.width = `${Math.round((m.requests / maxReq) * 100)}%`;
    row.append(bar, el("span", "bval", `${m.requests} (${m.errors5xx}×5xx, ${m.errors429}×429)`));
    minEl.append(row);
  }

  // Funnel
  const table = $("funnel");
  const head = el("tr");
  for (const h of ["day", "created", "opened", "answered", "picked up", "cancelled", "expired (no ans)", "expired (ans)", "hub clicks"]) head.append(el("th", "", h));
  table.append(head);
  const pct = (of, part) => (of ? ` ${Math.round((part / of) * 100)}%` : "");
  for (const day of [...dayMap.keys()].sort().reverse()) {
    const c = get(dayMap, day, "created"), o = get(dayMap, day, "opened"), a = get(dayMap, day, "answered"), p = get(dayMap, day, "picked_up");
    const tr = el("tr");
    tr.append(
      el("td", "", day),
      el("td", "", fmt(c)),
      el("td", "", fmt(o) + pct(c, o)),
      el("td", "", fmt(a) + pct(o, a)),
      el("td", "", fmt(p) + pct(a, p)),
      el("td", "", fmt(get(dayMap, day, "cancelled"))),
      el("td", "", fmt(get(dayMap, day, "expired_unanswered"))),
      el("td", "", fmt(get(dayMap, day, "expired_answered"))),
      el("td", "", fmt(get(dayMap, day, "hub_click"))),
    );
    table.append(tr);
  }

  // Distributions
  const tto = bucketTotals(dayMap, "time_to_open");
  const tta = bucketTotals(dayMap, "time_to_answer");
  const TORDER = ["<1m", "1-5m", "5-15m", "15-30m", "30-60m", ">60m"];
  const distBlock = (buckets, order) => {
    const div = el("div");
    const med = percentile(buckets, order, 0.5), p90 = percentile(buckets, order, 0.9);
    div.append(el("p", "meta", med ? `median ≈ ${med} · p90 ≈ ${p90}` : "no data"));
    bars(div, buckets, order);
    return div;
  };
  $("tto").append(el("h3", "", "to open"), distBlock(tto, TORDER));
  $("tta").append(el("h3", "", "to answer"), distBlock(tta, TORDER));

  const named = (id, name) => {
    const t = bucketTotals(dayMap, name);
    const div = $(id);
    bars(div, t, [...t.keys()].sort((a, b) => (t.get(b) || 0) - (t.get(a) || 0)));
  };
  named("agents", "agent");
  named("versions", "cli_version");
  bars($("sizes"), bucketTotals(dayMap, "grill_size"), ["<1k", "1-2k", "2-5k", "5-10k", "10-20k"]);
  bars($("questions"), bucketTotals(dayMap, "questions"), ["1", "2-3", "4-6", "7-10", "11-20", "21-30"]);
}

function card(title, value) {
  const c = el("div", "card");
  c.append(el("div", "ct", title), el("div", "cv", value));
  return c;
}

fetch("/stats/data.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then(render)
  .catch((e) => { $("generated").textContent = `Couldn't load the stats: ${e.message}`; });
