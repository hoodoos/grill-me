// Grillings: an agent's questions, answered on the grill page one card at a time.
// Free text in the format of the user's grilling skill:
//   ❓ Q3 - <title>
//   <self-contained body; choices as bullets that start with a bold short name>
//   ➡️ <recommendation>
//   ---
// Parsing is lenient (bold or not, "-" or ":" after the number) because agents drift.

const HEADER = /^\s{0,3}(?:[-*>]\s*|#{1,6}\s+)?(?:\*\*|__)?\s*❓️?\s*(?:\*\*|__)?\s*Q\s*(\d{1,3})(?![\d])\s*(.*)$/u;
const REC = /^\s{0,3}(?:>\s*)?(?:[-*]\s+)?(\*\*|__)?\s*➡️?\s*(.*)$/u;
const LOOSE_HEADER = /^\s{0,3}(?:[-*>]\s*|#{1,6}\s+)?(?:\*\*|__)?\s*❓️?\s*(\S.*)$/u;
const SEPARATOR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const OPTION = /^\s{0,3}[-*•]\s+(?:\*\*|__)(.+?)(?:\*\*|__)/;
const LISTISH = /^\s*(?:[-*•]\s|\d+[.)]\s|\||\s{2,}\S)/;

const unbold = (s) => {
  let t = s.trim();
  if ((t.match(/\*\*/g) || []).length % 2) t = t.replace(/^\*\*|\*\*$/g, "").trim(); // a bold that opened before "Q1"
  return t;
};
const trimLines = (lines) => {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b).join("\n");
};

// The header's text after "Q<n>": a title, sometimes followed on the same line by the start of the body.
function splitHeader(rest) {
  let r = rest.replace(/^\s*(?:\*\*|__)?\s*[-–—:.)]\s*/, "");
  let m = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*[:.\-–—]?\s*(.*)$/.exec(r);
  if (m) return { title: m[1].replace(/[:\s]+$/, "").trim(), body: m[2].trim() };
  r = unbold(r).replace(/\*\*/g, "");
  if (r.length > 140 && (m = /^(.{8,140}?)[:.]\s+(.+)$/.exec(r))) return { title: m[1].trim(), body: m[2].trim() };
  return { title: r.replace(/[:\s]+$/, "").trim(), body: "" };
}

export function parseGrill(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  // Which lines are inside a code block (never headers, recommendations or separators).
  const code = [];
  let fence = null;
  for (const l of lines) {
    const f = FENCE.exec(l);
    if (f && (!fence || f[1] === fence)) { code.push(true); fence = fence ? null : f[1]; continue; }
    code.push(!!fence);
  }
  const heads = [];
  lines.forEach((l, i) => { const m = !code[i] && HEADER.exec(l); if (m) heads.push({ i, n: Number(m[1]), rest: m[2] }); });
  // A one-off question often comes unnumbered ("❓ **Texel density** …"): with no numbered ones, number them in order.
  if (!heads.length) lines.forEach((l, i) => { const m = !code[i] && LOOSE_HEADER.exec(l); if (m) heads.push({ i, n: heads.length + 1, rest: "- " + m[1] }); });
  const questions = [];
  let outro = "";
  heads.forEach((h, k) => {
    const last = k === heads.length - 1;
    const end = last ? lines.length : heads[k + 1].i;
    const { title, body: first } = splitHeader(h.rest);
    const at = (re, from) => { for (let i = from; i < end; i++) if (!code[i] && re.test(lines[i])) return i; return -1; };
    const rec = at(REC, h.i + 1);
    // A question ends at the first separator after its recommendation (or after its header, if it has none).
    const sep = at(SEPARATOR, rec >= 0 ? rec + 1 : h.i + 1);
    let stop = sep >= 0 ? sep : end;
    if (last && rec >= 0 && sep < 0) {
      // The last question with no closing separator: its recommendation ends at the first paragraph that isn't
      // part of it (e.g. "Answer like Q1 - agree…").
      for (let i = rec + 1; i < end - 1; i++) {
        if (!lines[i].trim() && lines[i + 1].trim() && !code[i + 1] && !LISTISH.test(lines[i + 1])) { stop = i; break; }
      }
    }
    const bodyLines = [first, ...lines.slice(h.i + 1, rec >= 0 ? rec : stop)];
    let recText = null;
    if (rec >= 0) {
      const m = REC.exec(lines[rec]);
      // "**➡️ Do this**": the bold opened before the arrow, so drop its other half.
      const firstLine = m[1] && (m[2].match(/\*\*/g) || []).length % 2 ? m[2].replace("**", "") : m[2];
      recText = trimLines([firstLine, ...lines.slice(rec + 1, stop)]) || null;
    }
    const options = [];
    for (let i = 1; i < bodyLines.length; i++) {
      const m = !code[h.i + i] && OPTION.exec(bodyLines[i]);
      const name = m && m[1].replace(/[\s.,:;—–-]+$/, "").trim();
      if (name && name.length <= 80) options.push(name);
    }
    questions.push({ n: h.n, title: title || `Question ${h.n}`, body: trimLines(bodyLines), rec: recText, options: options.length >= 2 ? options : [] });
    if (last) outro = trimLines(lines.slice(stop + (stop === sep ? 1 : 0)));
  });
  return { intro: heads.length ? trimLines(lines.slice(0, heads[0].i)) : "", questions, outro };
}

// A built-in grilling for trying the page (?grill=demo): Send only shows what it would post.
export const DEMO_TEXT = `A few questions before I start. Swipe right to agree, left to write your own.

❓ Q1 - Where the new button goes
The session card gets a button that opens this page. It can sit next to Send, or at the top of the card where you look first.

➡️ At the top of the card, under the title.

---

❓ Q2 - Which colour scheme
- **Follow the phone**: light or dark, whatever the system uses.
- **Always dark**: matches the terminal.
- **Always light**: easiest to read outside.

➡️ Follow the phone.

---

❓ Q3 - How long to keep old answers
Answers you haven't sent yet stay on this device. A long body scrolls inside the card without moving it, so this one is deliberately long to try that.

Line after line of detail about the trade-off: keeping them longer means you can come back to a half-done grilling after a weekend; keeping them shorter means less clutter on the phone and fewer stale answers for sessions that moved on long ago. There's also the question of what happens when the agent asks again with new numbering, and whether a saved answer should ever carry over to a new message (it shouldn't: the fingerprint changes).

Another paragraph so the card has to scroll on a phone. And one more line. And one more.

➡️ Three days, then drop them.

---

❓ Q4 - Anything you'd name differently
No recommendation here: tell me in your own words.

---

Answer like "Q1 - agree, Q3 - …".`;
