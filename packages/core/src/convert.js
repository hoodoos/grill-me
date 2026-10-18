// Any question format in, one internal format out. Every successful path ends in validateGrill.
import { parseGrill, FENCE, OPTION } from "./grill-text.js";
import { GRILL_SCHEMA, validateGrill } from "./format.js";

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const BULLET = /^\s*[-*•]\s/;

// Trim outer blank lines; collapse runs of 3+ newlines to 2.
const tidyBody = (lines) => {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b).join("\n").replace(/\n{3,}/g, "\n\n");
};

// The hub page's rule for matching a recommendation to a choice name.
const norm = (t) => " " + String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
const recommendedChoice = (rec, choices) => {
  let m = choices.filter((c) => norm(rec).startsWith(norm(c.name)));
  if (!m.length) m = choices.filter((c) => norm(rec).includes(norm(c.name)));
  return m.length === 1 ? m[0].name : null;
};

// Grill text → internal format. Returns null when the text has no questions.
export function fromGrillText(text) {
  const parsed = parseGrill(text);
  if (!parsed.questions.length) return null;
  const questions = parsed.questions.map((q) => {
    // Re-scan the parsed body for the bold-named bullets that became options, to take their details
    // out of the body. Local fence tracking is exact: a body always starts outside a code block.
    const bodyLines = q.body.split("\n");
    const entries = [];
    const drop = new Set();
    let fence = null;
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      const f = FENCE.exec(line);
      if (f && (!fence || f[1] === fence)) { fence = fence ? null : f[1]; continue; }
      if (fence) continue;
      const m = OPTION.exec(line);
      const name = m && m[1].replace(/[\s.,:;—–-]+$/, "").trim();
      if (!name || name.length > 80) continue;
      const parts = [line.slice(m[0].length).replace(/^[\s:.,\-–—]+/, "")];
      drop.add(i);
      for (let j = i + 1; j < bodyLines.length; j++) {
        const cont = bodyLines[j];
        if (!cont.trim() || !/^\s{2,}\S/.test(cont) || BULLET.test(cont)) break;
        parts.push(cont.trim());
        drop.add(j);
        i = j;
      }
      entries.push({ name, detail: parts.filter(Boolean).join(" ").trim() });
    }
    const choices = entries.length >= 2 ? entries : [];
    return {
      n: q.n,
      title: q.title,
      body: choices.length ? tidyBody(bodyLines.filter((_, i) => !drop.has(i))) : q.body,
      choices,
      recommend: q.rec === null ? null : { choice: recommendedChoice(q.rec, choices), why: q.rec },
      multi: false,
    };
  });
  return { questions };
}

const cleanLabel = (label) => ({
  name: String(label).replace(/\s*\(recommended\)\s*/i, " ").trim(),
  recommended: /\(recommended\)/i.test(String(label)),
});

const mapPicker = (obj, { multi }) => {
  const qs = obj.questions;
  if (!Array.isArray(qs) || !qs.length) return null;
  return {
    questions: qs.map((q, i) => {
      const options = (q.options || []).map((o) => (isObject(o) ? { label: o.label ?? o.name ?? o.value ?? "", description: o.description } : { label: o, description: undefined }));
      const cleaned = options.map((o) => ({ ...cleanLabel(o.label), detail: o.description || "" }));
      const rec = cleaned.find((c) => c.recommended);
      return {
        n: i + 1,
        title: q.header || q.question,
        body: q.header ? q.question || "" : "",
        choices: cleaned.map((c) => ({ name: c.name, detail: c.detail })),
        recommend: rec ? { choice: rec.name, why: "" } : null,
        multi: multi ? !!q.multiSelect : false,
      };
    }),
  };
};

// Claude's AskUserQuestion picker: questions[].question/header/multiSelect/options[].label/description.
export function fromAskUserQuestion(obj) {
  return mapPicker(obj, { multi: true });
}

// Codex request_user_input: questions[].id/header/question/options[] (objects or strings), isOther/isSecret.
export function fromCodex(obj) {
  if (Array.isArray(obj?.questions) && obj.questions.some((q) => isObject(q) && q.isSecret)) {
    return { failed: "secret questions can't be sent to a phone" };
  }
  return mapPicker(obj, { multi: false });
}

// Plain numbered markdown, last resort: "1. Question?" followed by "- option" bullets.
export function fromNumbered(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const items = [];
  let item = null;
  let fence = null;
  const NUMBERED = /^\s{0,3}(\d{1,3})[.)]\s+(.+)$/;
  const BULLET_LINE = /^\s{0,3}[-*•]\s+(.+)$/;
  const REC_LINE = /^\s{0,3}(?:➡️|➡|Recommended:|Recommendation:)\s*(.*)$/;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f && (!fence || f[1] === fence)) { fence = fence ? null : f[1]; continue; }
    if (fence) continue;
    const qm = NUMBERED.exec(line);
    if (qm) {
      item = { n: Number(qm[1]), title: qm[2].trim().replace(/^(?:\*\*|__)(.*)(?:\*\*|__)$/, "$1").trim(), bodyLines: [], choices: [], recommend: null, marked: false };
      items.push(item);
      continue;
    }
    if (!item) continue;
    const rm = REC_LINE.exec(line);
    if (rm) {
      item.recommend = { choice: item.recommend ? item.recommend.choice : undefined, why: rm[1].trim() };
      continue;
    }
    const bm = BULLET_LINE.exec(line);
    if (bm) {
      let text2 = bm[1].trim();
      let marked = false;
      if (/\(recommended\)/i.test(text2)) {
        marked = true;
        text2 = text2.replace(/\s*\(recommended\)\s*/i, " ").trim();
      }
      let name, detail = "";
      const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)(.*)$/.exec(text2);
      if (bold) {
        name = bold[1].replace(/[\s.,:;—–-]+$/, "").trim();
        detail = bold[2].replace(/^[\s:.,\-–—]+/, "").trim();
      } else {
        const split = /^(.{1,80}?)(?:: | — | – | - )(.+)$/.exec(text2);
        if (split) { name = split[1].trim(); detail = split[2].trim(); }
        else if (text2.length <= 80) name = text2;
        else {
          let cut = text2.slice(0, 77);
          const sp = cut.lastIndexOf(" ");
          if (sp > 0) cut = cut.slice(0, sp);
          name = cut + "…";
          detail = text2;
        }
      }
      item.choices.push({ name, detail });
      if (marked && !item.marked) {
        item.marked = true;
        item.recommend = { choice: name, why: item.recommend ? item.recommend.why : "" };
      }
      continue;
    }
    item.bodyLines.push(line);
  }
  const questions = [];
  for (const it of items) {
    if (!it.title.endsWith("?") && it.choices.length < 2) continue; // a numbered list of steps is not a grill
    if (it.recommend && it.recommend.choice === undefined) {
      it.recommend.choice = it.marked ? it.recommend.choice : recommendedChoice(it.recommend.why, it.choices);
    }
    questions.push({
      n: it.n,
      title: it.title,
      body: tidyBody(it.bodyLines),
      choices: it.choices,
      recommend: it.recommend && (it.recommend.choice || it.recommend.why) ? it.recommend : null,
      multi: false,
    });
  }
  return questions.length ? { questions } : null;
}

// Object dispatch: internal format vs Claude's picker vs Codex, plus the tool-call wrappers.
const fromObject = (obj) => {
  const container = Array.isArray(obj.questions) ? obj
    : isObject(obj.input) && Array.isArray(obj.input.questions) ? obj.input
    : isObject(obj.arguments) && Array.isArray(obj.arguments.questions) ? obj.arguments
    : null;
  if (!container) return { error: 'no "questions" array found' };
  const qs = container.questions;
  const has = (k) => qs.some((q) => isObject(q) && k in q);
  if (has("title") || !has("question")) return { source: "structured", raw: container };
  if (has("id")) return { source: "codex", raw: fromCodex(container) };
  return { source: "ask-user-question", raw: fromAskUserQuestion(container) };
};

const fromString = (text) => {
  const grill = fromGrillText(text);
  if (grill) return { source: "grill-text", raw: grill };
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1];
  try {
    const parsed = JSON.parse(t);
    if (isObject(parsed)) return fromObject(parsed);
  } catch { /* not JSON: try numbered markdown */ }
  const numbered = fromNumbered(text);
  if (numbered) return { source: "numbered", raw: numbered };
  return {
    error:
      "no questions found. Accepted formats: the internal grill JSON (see schema), grill text " +
      '("❓ Q1 - title", body, "➡️ recommendation"), Claude AskUserQuestion or Codex request_user_input JSON, ' +
      'or numbered markdown ("1. Question?" followed by "- option" bullets).',
  };
};

// convert(input, { title } = {}) → { ok: true, grill, source } or { ok: false, error, schema }.
export function convert(input, { title } = {}) {
  const res = isObject(input) ? fromObject(input)
    : typeof input === "string" ? fromString(input)
    : { error: "expected a grill object or text" };
  if (res.error) return { ok: false, error: res.error, schema: GRILL_SCHEMA };
  if (res.raw && res.raw.failed) return { ok: false, error: res.raw.failed, schema: GRILL_SCHEMA };
  const raw = title !== undefined ? { ...res.raw, title } : res.raw;
  const v = validateGrill(raw);
  if (!v.ok) return { ok: false, error: v.errors.join("; "), schema: GRILL_SCHEMA };
  return { ok: true, grill: v.grill, source: res.source };
}
