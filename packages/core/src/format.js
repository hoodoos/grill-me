// The normalized grill (what gets encrypted and uploaded) and the answers to it, with validation.
// Output key order is fixed, so JSON.stringify of a normalized grill is canonical.

export const LIMITS = {
  questions: 30,
  grillBytes: 20480, // ciphertext bytes (decoded, tag included)
  answersBytes: 8192,
  titleChars: 200,
  bodyChars: 4000,
  choices: 12,
  choiceNameChars: 80,
  choiceDetailChars: 1000,
  whyChars: 2000,
  ownChars: 4000,
};

// The MCP tool's input schema: the input form of the grill, one description per field.
export const GRILL_SCHEMA = {
  type: "object",
  description: "A grill: the questions an agent wants the user to answer on their phone.",
  properties: {
    v: { type: "integer", enum: [1], description: "Format version; omit it (defaults to 1)." },
    title: { type: "string", maxLength: LIMITS.titleChars, description: "Optional short name for the whole grill." },
    questions: {
      type: "array",
      maxItems: LIMITS.questions,
      description: "The questions, in the order the user swipes through them (1–30).",
      items: {
        type: "object",
        properties: {
          n: { type: "integer", description: "Question number; omit to continue from the previous one (first is 1)." },
          title: { type: "string", maxLength: LIMITS.titleChars, description: "Short question title (required)." },
          body: { type: "string", maxLength: LIMITS.bodyChars, description: "Self-contained context shown on the card; **bold** and `code` only." },
          choices: {
            type: "array",
            maxItems: LIMITS.choices,
            description: "Tappable options.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", maxLength: LIMITS.choiceNameChars, description: "Short choice name, unique within the question." },
                detail: { type: "string", maxLength: LIMITS.choiceDetailChars, description: "What picking this choice means." },
              },
              required: ["name"],
            },
          },
          recommend: {
            type: "object",
            description: "The choice you advise. Omit for no recommendation.",
            properties: {
              choice: { type: "string", description: "Name of the recommended choice; omit if none." },
              why: { type: "string", maxLength: LIMITS.whyChars, description: "Why you recommend it." },
            },
          },
          multi: { type: "boolean", description: "true = the user may pick several choices." },
        },
        required: ["title"],
      },
    },
  },
  required: ["questions"],
};

// Trim outer blank lines only (inner newlines and indentation are kept).
const trimBlankLines = (s) => {
  const lines = s.split("\n");
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b).join("\n");
};

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// validateGrill(input) → { ok: true, grill } (normalized) or { ok: false, errors }.
export function validateGrill(input) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  if (!isObject(input)) return { ok: false, errors: ["grill: must be an object"] };

  const v = input.v === undefined ? 1 : input.v;
  if (v !== 1) err("v", "must be 1");

  let title;
  if (input.title !== undefined) {
    if (typeof input.title !== "string") err("title", "must be a string");
    else {
      title = input.title.trim();
      if (title.length > LIMITS.titleChars) err("title", `at most ${LIMITS.titleChars} characters`);
      if (!title) title = undefined;
    }
  }

  const qs = input.questions;
  if (!Array.isArray(qs)) {
    err("questions", qs === undefined ? "required" : "must be an array");
    return { ok: false, errors };
  }
  if (qs.length < 1) err("questions", "at least 1 question");
  if (qs.length > LIMITS.questions) err("questions", `at most ${LIMITS.questions}`);

  const questions = [];
  const seen = new Set();
  let prev = 0;
  qs.forEach((q, i) => {
    const path = `questions[${i}]`;
    if (!isObject(q)) { err(path, "must be an object"); return; }

    let n;
    if (q.n === undefined) n = prev + 1;
    else if (!Number.isInteger(q.n) || q.n < 1 || q.n > 999) err(`${path}.n`, "must be an integer 1..999");
    else n = q.n;
    if (n !== undefined) {
      if (seen.has(n)) err(`${path}.n`, `duplicate question number ${n}`);
      seen.add(n);
      prev = n;
    }

    let qtitle;
    if (typeof q.title !== "string") err(`${path}.title`, "required");
    else {
      qtitle = q.title.trim();
      if (!qtitle) err(`${path}.title`, "required");
      else if (qtitle.length > LIMITS.titleChars) err(`${path}.title`, `at most ${LIMITS.titleChars} characters`);
    }

    let body = "";
    if (q.body !== undefined) {
      if (typeof q.body !== "string") err(`${path}.body`, "must be a string");
      else {
        body = trimBlankLines(q.body);
        if (body.length > LIMITS.bodyChars) err(`${path}.body`, `at most ${LIMITS.bodyChars} characters`);
      }
    }

    const choices = [];
    const names = new Map(); // lowercase name -> index in choices
    const rawChoices = q.choices === undefined ? [] : q.choices;
    if (!Array.isArray(rawChoices)) err(`${path}.choices`, "must be an array");
    else {
      if (rawChoices.length > LIMITS.choices) err(`${path}.choices`, `at most ${LIMITS.choices}`);
      rawChoices.forEach((c, j) => {
        const cpath = `${path}.choices[${j}]`;
        const co = typeof c === "string" ? { name: c } : c;
        if (!isObject(co)) { err(cpath, "must be an object or a string"); return; }
        let name;
        if (typeof co.name !== "string" || !co.name.trim()) err(`${cpath}.name`, "required");
        else {
          name = co.name.trim();
          if (name.length > LIMITS.choiceNameChars) err(`${cpath}.name`, `at most ${LIMITS.choiceNameChars} characters`);
          const key = name.toLowerCase();
          if (names.has(key)) err(`${cpath}.name`, `duplicate choice "${name}"`);
          else names.set(key, choices.length);
        }
        let detail = "";
        if (co.detail !== undefined) {
          if (typeof co.detail !== "string") err(`${cpath}.detail`, "must be a string");
          else {
            detail = co.detail.trim();
            if (detail.length > LIMITS.choiceDetailChars) err(`${cpath}.detail`, `at most ${LIMITS.choiceDetailChars} characters`);
          }
        }
        if (name !== undefined) choices.push({ name, detail });
      });
    }

    let recommend = null;
    if (q.recommend !== undefined && q.recommend !== null) {
      const r = q.recommend;
      if (!isObject(r)) err(`${path}.recommend`, "must be an object or null");
      else {
        let choice = null;
        if (r.choice !== undefined && r.choice !== null && r.choice !== "") {
          if (typeof r.choice !== "string") err(`${path}.recommend.choice`, "must be a string or null");
          else {
            const at = names.get(r.choice.trim().toLowerCase());
            if (at === undefined) err(`${path}.recommend.choice`, `no choice named "${r.choice}"`);
            else choice = choices[at].name;
          }
        }
        let why = "";
        if (r.why !== undefined) {
          if (typeof r.why !== "string") err(`${path}.recommend.why`, "must be a string");
          else {
            why = trimBlankLines(r.why);
            if (why.length > LIMITS.whyChars) err(`${path}.recommend.why`, `at most ${LIMITS.whyChars} characters`);
          }
        }
        if (choice !== null || why) recommend = { choice, why };
      }
    }

    let multi = false;
    if (q.multi !== undefined) {
      if (typeof q.multi !== "boolean") err(`${path}.multi`, "must be a boolean");
      else multi = q.multi;
    }
    if (choices.length < 2) multi = false;

    if (n !== undefined && qtitle !== undefined) questions.push({ n, title: qtitle, body, choices, recommend, multi });
  });

  if (errors.length) return { ok: false, errors };
  const grill = { v, ...(title !== undefined ? { title } : {}), questions };
  return { ok: true, grill };
}

// validateAnswers(input, grill) → { ok: true, answers } or { ok: false, errors }.
// answers = { v: 1, answers: [{ n, kind, choice?, text? }] } sorted in the grill's question order.
export function validateAnswers(input, grill) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  if (!isObject(input)) return { ok: false, errors: ["answers: must be an object"] };
  const v = input.v === undefined ? 1 : input.v;
  if (v !== 1) err("v", "must be 1");
  const list = input.answers;
  if (!Array.isArray(list)) {
    err("answers", list === undefined ? "required" : "must be an array");
    return { ok: false, errors };
  }

  const byN = new Map(grill.questions.map((q, i) => [q.n, { q, i }]));
  const out = [];
  const seen = new Set();
  list.forEach((a, i) => {
    const path = `answers[${i}]`;
    if (!isObject(a)) { err(path, "must be an object"); return; }
    const slot = byN.get(a.n);
    if (!slot) { err(`${path}.n`, `no question ${JSON.stringify(a.n)} in the grill`); return; }
    if (seen.has(a.n)) { err(`${path}.n`, `more than one answer for Q${a.n}`); return; }
    seen.add(a.n);
    const { q } = slot;

    let answer = null;
    switch (a.kind) {
      case "agree":
        if (!q.recommend) err(path, `Q${a.n} has no recommendation to agree with`);
        else answer = { n: a.n, kind: "agree" };
        break;
      case "choice": {
        const raw = Array.isArray(a.choice) ? a.choice : a.choice === undefined ? undefined : [a.choice];
        if (!raw || !raw.length) { err(`${path}.choice`, "required"); break; }
        if (!q.multi && raw.length > 1) { err(`${path}.choice`, `Q${a.n} is not multi-select`); break; }
        const picked = [];
        const pickedKeys = new Set();
        let bad = false;
        for (const c of raw) {
          if (typeof c !== "string") { err(`${path}.choice`, "must be a choice name"); bad = true; break; }
          const match = q.choices.find((o) => o.name.toLowerCase() === c.trim().toLowerCase());
          if (!match) { err(`${path}.choice`, `no choice named "${c}" in Q${a.n}`); bad = true; break; }
          const key = match.name.toLowerCase();
          if (pickedKeys.has(key)) { err(`${path}.choice`, `choice "${match.name}" picked twice`); bad = true; break; }
          pickedKeys.add(key);
          picked.push(match.name);
        }
        if (!bad) answer = { n: a.n, kind: "choice", choice: q.multi ? picked : picked[0] };
        break;
      }
      case "own": {
        if (typeof a.text !== "string" || !a.text.trim()) { err(`${path}.text`, "required"); break; }
        const text = a.text.trim();
        if (text.length > LIMITS.ownChars) { err(`${path}.text`, `at most ${LIMITS.ownChars} characters`); break; }
        answer = { n: a.n, kind: "own", text };
        break;
      }
      case "skip":
        answer = { n: a.n, kind: "skip" };
        break;
      default:
        err(`${path}.kind`, a.kind === undefined ? "required" : `unknown kind ${JSON.stringify(a.kind)}`);
    }
    if (answer) out.push({ answer, order: slot.i });
  });

  if (errors.length) return { ok: false, errors };
  out.sort((x, y) => x.order - y.order);
  return { ok: true, answers: { v, answers: out.map((x) => x.answer) } };
}
