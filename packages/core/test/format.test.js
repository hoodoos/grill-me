import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, GRILL_SCHEMA, validateGrill } from "../src/index.js";

const base = { questions: [{ title: "Q?" }] };
const ok = (input) => {
  const r = validateGrill(input);
  assert.ok(r.ok, r.errors?.join("; "));
  return r.grill;
};
const bad = (input, match) => {
  const r = validateGrill(input);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  if (match) assert.match(r.errors.join("; "), match);
  return r.errors;
};

test("v: missing defaults to 1, anything else is an error", () => {
  assert.equal(ok(base).v, 1);
  bad({ v: 2, ...base }, /v: must be 1/);
  bad({ v: "1", ...base }, /v: must be 1/);
});

test("grill title: optional, trimmed, empty omitted, capped", () => {
  assert.equal(ok(base).title, undefined);
  assert.equal(ok({ title: "  Hi  ", ...base }).title, "Hi");
  assert.equal(ok({ title: "   ", ...base }).title, undefined);
  bad({ title: "x".repeat(LIMITS.titleChars + 1), ...base }, /title/);
  bad({ title: 5, ...base }, /title: must be a string/);
});

test("questions: required, an array, 1..30", () => {
  bad({}, /questions: required/);
  bad({ questions: "x" }, /questions: must be an array/);
  bad({ questions: [] }, /at least 1/);
  bad({ questions: Array.from({ length: 31 }, (_, i) => ({ title: `Q${i}` })) }, /at most 30/);
  assert.equal(ok({ questions: Array.from({ length: 30 }, (_, i) => ({ title: `Q${i}` })) }).questions.length, 30);
  bad({ questions: ["nope"] }, /questions\[0\]: must be an object/);
});

test("n: auto-numbering, integer 1..999, duplicates rejected", () => {
  assert.deepEqual(ok({ questions: [{ title: "a" }, { title: "b" }] }).questions.map((q) => q.n), [1, 2]);
  assert.deepEqual(ok({ questions: [{ n: 5, title: "a" }, { title: "b" }] }).questions.map((q) => q.n), [5, 6]);
  assert.deepEqual(ok({ questions: [{ n: 14, title: "a" }] }).questions[0].n, 14);
  bad({ questions: [{ n: 0, title: "a" }] }, /n: must be an integer 1\.\.999/);
  bad({ questions: [{ n: 1000, title: "a" }] }, /n: must be an integer 1\.\.999/);
  bad({ questions: [{ n: 1.5, title: "a" }] }, /n: must be an integer 1\.\.999/);
  bad({ questions: [{ n: 3, title: "a" }, { n: 3, title: "b" }] }, /duplicate question number 3/);
});

test("question title: required, non-empty after trim, capped", () => {
  bad({ questions: [{}] }, /questions\[0\]\.title: required/);
  bad({ questions: [{ title: "   " }] }, /title: required/);
  bad({ questions: [{ title: "x".repeat(201) }] }, /title/);
  assert.equal(ok({ questions: [{ title: "  Hi  " }] }).questions[0].title, "Hi");
});

test("body: default empty, outer blank lines trimmed, inner kept, capped", () => {
  assert.equal(ok(base).questions[0].body, "");
  bad({ questions: [{ title: "a", body: 5 }] }, /body: must be a string/);
  const g = ok({ questions: [{ title: "a", body: "\n\n  first\n\nsecond  \n\n" }] });
  assert.equal(g.questions[0].body, "  first\n\nsecond  ");
  bad({ questions: [{ title: "a", body: "x".repeat(LIMITS.bodyChars + 1) }] }, /body/);
});

test("choices: defaults, bare strings, name rules, uniqueness", () => {
  assert.deepEqual(ok(base).questions[0].choices, []);
  const g = ok({ questions: [{ title: "a", choices: [" one ", { name: "Two", detail: "d" }] }] });
  assert.deepEqual(g.questions[0].choices, [{ name: "one", detail: "" }, { name: "Two", detail: "d" }]);
  bad({ questions: [{ title: "a", choices: [{}] }] }, /choices\[0\]\.name: required/);
  bad({ questions: [{ title: "a", choices: ["  "] }] }, /name: required/);
  bad({ questions: [{ title: "a", choices: ["x".repeat(81)] }] }, /name/);
  bad({ questions: [{ title: "a", choices: ["Same", "same"] }] }, /duplicate choice/);
  bad({ questions: [{ title: "a", choices: Array.from({ length: 13 }, (_, i) => `c${i}`) }] }, /at most 12/);
  bad({ questions: [{ title: "a", choices: [{ name: "x", detail: "d".repeat(1001) }] }] }, /detail/);
  bad({ questions: [{ title: "a", choices: [42] }] }, /must be an object or a string/);
});

test("recommend: default null, choice matched case-insensitively, both empty means null", () => {
  assert.equal(ok(base).questions[0].recommend, null);
  const g = ok({ questions: [{ title: "a", choices: ["Alpha", "Beta"], recommend: { choice: "alpha", why: "best" } }] });
  assert.deepEqual(g.questions[0].recommend, { choice: "Alpha", why: "best" });
  const whyOnly = ok({ questions: [{ title: "a", recommend: { why: "because" } }] });
  assert.deepEqual(whyOnly.questions[0].recommend, { choice: null, why: "because" });
  assert.equal(ok({ questions: [{ title: "a", recommend: {} }] }).questions[0].recommend, null);
  assert.equal(ok({ questions: [{ title: "a", recommend: null }] }).questions[0].recommend, null);
  bad({ questions: [{ title: "a", choices: ["Alpha"], recommend: { choice: "Gamma" } }] }, /no choice named "Gamma"/);
  bad({ questions: [{ title: "a", recommend: { choice: "x", why: "y".repeat(2001) } }] }, /why|no choice/);
  bad({ questions: [{ title: "a", recommend: "Alpha" }] }, /recommend: must be an object or null/);
});

test("multi: default false, forced false with fewer than 2 choices", () => {
  assert.equal(ok(base).questions[0].multi, false);
  assert.equal(ok({ questions: [{ title: "a", choices: ["x"], multi: true }] }).questions[0].multi, false);
  assert.equal(ok({ questions: [{ title: "a", choices: ["x", "y"], multi: true }] }).questions[0].multi, true);
  bad({ questions: [{ title: "a", multi: "yes" }] }, /multi: must be a boolean/);
});

test("unknown fields are dropped and key order is canonical", () => {
  const g = ok({
    v: 1, title: "T", extra: "drop me",
    questions: [{ n: 2, title: "a", body: "b", choices: [{ name: "x", detail: "", bogus: 1 }], recommend: { choice: "x", why: "w", junk: 2 }, multi: false, zzz: 3 }],
  });
  assert.deepEqual(Object.keys(g), ["v", "title", "questions"]);
  assert.deepEqual(Object.keys(g.questions[0]), ["n", "title", "body", "choices", "recommend", "multi"]);
  assert.deepEqual(Object.keys(g.questions[0].choices[0]), ["name", "detail"]);
  assert.deepEqual(Object.keys(g.questions[0].recommend), ["choice", "why"]);
  assert.equal(JSON.stringify(g), JSON.stringify({ ...g, questions: [...g.questions] }));
});

test("GRILL_SCHEMA describes the input form", () => {
  assert.equal(GRILL_SCHEMA.type, "object");
  assert.deepEqual(GRILL_SCHEMA.required, ["questions"]);
  const q = GRILL_SCHEMA.properties.questions.items;
  for (const field of ["n", "title", "body", "choices", "recommend", "multi"]) {
    assert.ok(q.properties[field], field);
    assert.ok(q.properties[field].description, `${field} description`);
  }
  assert.equal(GRILL_SCHEMA.properties.questions.maxItems, LIMITS.questions);
});
