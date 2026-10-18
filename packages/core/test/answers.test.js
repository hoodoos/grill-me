import test from "node:test";
import assert from "node:assert/strict";
import { validateGrill, validateAnswers, answerLines } from "../src/index.js";

const grill = validateGrill({
  questions: [
    { n: 1, title: "One", recommend: { why: "do it" } },
    { n: 2, title: "Two", choices: ["Alpha", "Beta"], recommend: { choice: "Alpha" } },
    { n: 3, title: "Three", choices: ["Red", "Green", "Blue"], multi: true },
    { n: 4, title: "Four" },
  ],
}).grill;

const ok = (input) => {
  const r = validateAnswers(input, grill);
  assert.ok(r.ok, r.errors?.join("; "));
  return r.answers;
};
const bad = (input, match) => {
  const r = validateAnswers(input, grill);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  if (match) assert.match(r.errors.join("; "), match);
};

test("every kind renders as the hub's line", () => {
  const answers = ok({
    answers: [
      { n: 1, kind: "agree" },
      { n: 2, kind: "choice", choice: "beta" },
      { n: 4, kind: "own", text: "my own\nanswer here" },
    ],
  });
  assert.equal(
    answerLines(grill, answers),
    "Q1 - agree\nQ2 - Beta\nQ3 - skip for now, ask again later\nQ4 - my own answer here",
  );
});

test("multi answers join with a comma", () => {
  const answers = ok({ answers: [{ n: 3, kind: "choice", choice: ["blue", "RED"] }] });
  assert.deepEqual(answers.answers[0].choice, ["Blue", "Red"]);
  assert.equal(answerLines(grill, answers), `Q1 - skip for now, ask again later\nQ2 - skip for now, ask again later\nQ3 - Blue, Red\nQ4 - skip for now, ask again later`);
});

test("skip renders the hub's exact wording, as does a missing answer", () => {
  const answers = ok({ answers: [{ n: 1, kind: "skip" }] });
  assert.equal(answerLines(grill, answers).split("\n")[0], "Q1 - skip for now, ask again later");
});

test("no trailing newline and one line per question", () => {
  const lines = answerLines(grill, ok({ answers: [] }));
  assert.equal(lines.split("\n").length, 4);
  assert.ok(!lines.endsWith("\n"));
});

test("output answers are sorted in the grill's question order", () => {
  const answers = ok({ answers: [{ n: 4, kind: "skip" }, { n: 1, kind: "agree" }, { n: 2, kind: "choice", choice: "Alpha" }] });
  assert.deepEqual(answers.answers.map((a) => a.n), [1, 2, 4]);
  assert.deepEqual(Object.keys(answers), ["v", "answers"]);
});

test("choice normalizes to the declared spelling; a 1-element array on non-multi becomes a string", () => {
  const answers = ok({ answers: [{ n: 2, kind: "choice", choice: ["ALPHA"] }] });
  assert.equal(answers.answers[0].choice, "Alpha");
});

test("validation errors", () => {
  bad({}, /answers: required/);
  bad({ v: 2, answers: [] }, /v: must be 1/);
  bad({ answers: [{ n: 9, kind: "skip" }] }, /no question 9/);
  bad({ answers: [{ n: 1, kind: "skip" }, { n: 1, kind: "skip" }] }, /more than one answer/);
  bad({ answers: [{ n: 1 }] }, /kind: required/);
  bad({ answers: [{ n: 1, kind: "shrug" }] }, /unknown kind/);
  bad({ answers: [{ n: 4, kind: "agree" }] }, /no recommendation to agree with/);
  bad({ answers: [{ n: 2, kind: "choice" }] }, /choice: required/);
  bad({ answers: [{ n: 2, kind: "choice", choice: "Gamma" }] }, /no choice named "Gamma"/);
  bad({ answers: [{ n: 2, kind: "choice", choice: ["Alpha", "Beta"] }] }, /not multi-select/);
  bad({ answers: [{ n: 3, kind: "choice", choice: ["Red", "red"] }] }, /picked twice/);
  bad({ answers: [{ n: 3, kind: "choice", choice: [] }] }, /choice: required/);
  bad({ answers: [{ n: 4, kind: "own" }] }, /text: required/);
  bad({ answers: [{ n: 4, kind: "own", text: "   " }] }, /text: required/);
  bad({ answers: [{ n: 4, kind: "own", text: "x".repeat(4001) }] }, /at most 4000/);
});
